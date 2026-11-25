#!/usr/bin/env python3
"""Read-only TP-Link Tapo Thing Cloud diagnostic (no LAN fallback)."""
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlparse

THING_APP = "TP-Link_Tapo_Android"
THING_VERSION = "3.13.818"
THING_SUFFIX = "-app-server.iot.i.tplinkcloud.com"
THING_SERVICES = [
    "nbu.iot-app-server.app-v2",
    "nbu.iot-cloud-gateway.app-v2",
    "nbu.iot-security.appdevice-v2",
]


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def valid_thing_host(raw):
    parsed = urlparse(str(raw or "").rstrip("/"))
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or
            parsed.port or parsed.path or not host.endswith(THING_SUFFIX) or
            not host[:-len(THING_SUFFIX)] or
            any(not (c.islower() or c.isdigit() or c == "-") for c in host[:-len(THING_SUFFIX)])):
        raise ValueError("TP-Link returned an invalid Thing API host.")
    return "https://" + host


def api_error(payload):
    if not isinstance(payload, dict):
        return "Invalid response from TP-Link."
    code = payload.get("error_code", payload.get("errorCode", 0))
    try:
        code = int(code or 0)
    except (TypeError, ValueError):
        code = -1
    if code:
        message = payload.get("msg") or payload.get("errorMsg") or "Cloud API error"
        return "TP-Link Thing API error " + str(code) + ": " + str(message)[:180]
    return None


def add_diagnostic(items, stage, status, started, **details):
    entry = {"stage": stage, "status": status, "durationMs": max(0, int((time.monotonic() - started) * 1000))}
    if isinstance(details.get("code"), int):
        entry["code"] = details["code"]
    if isinstance(details.get("count"), int):
        entry["count"] = details["count"]
    items.append(entry)


def main():
    diagnostics = []
    active_stage = "authentication"
    stage_started = time.monotonic()
    try:
        data = json.load(sys.stdin)
        username = data.get("username")
        password = data.get("password")
        mfa_code = data.get("mfaCode") or ""
        if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
            emit({"ok": False, "code": "credentials_required", "message": "Укажите email и пароль аккаунта Tapo."})
            return
        import requests
        from tplinkcloud.client import TPLinkApi
        from tplinkcloud.exceptions import TPLinkAuthError, TPLinkCloudError, TPLinkMFARequiredError
    except ImportError:
        emit({"ok": False, "code": "dependency_missing", "message": "Не найдена библиотека tplink-cloud-api. Установите requirements-cloud.txt в Python-окружение Homebridge."})
        return
    except Exception:
        emit({"ok": False, "code": "invalid_input", "message": "Не удалось прочитать параметры проверки."})
        return

    try:
        api = TPLinkApi(cloud_type="tapo")
        callback = (lambda _kind, _email: mfa_code) if mfa_code else None
        stage_started = time.monotonic()
        auth = api.login(username.strip(), password, mfa_callback=callback)
        token = auth.get("token") if isinstance(auth, dict) else None
        if not token:
            add_diagnostic(diagnostics, "authentication", "failed", stage_started)
            emit({"ok": False, "code": "login_failed", "message": "TP-Link не вернул токен облачной сессии.", "diagnostics": diagnostics})
            return
        add_diagnostic(diagnostics, "authentication", "success", stage_started)

        # The Thing API uses a newer Tapo app identity than the account login API.
        api._query_params.update({"appName": THING_APP, "appVer": THING_VERSION})
        active_stage = "thing_service"
        stage_started = time.monotonic()
        service_response = api._request_post_v2(
            api.host,
            "/api/v2/common/getAppServiceUrlByCloudUserName",
            {"cloudUserName": username.strip(), "serviceIds": THING_SERVICES},
            token,
        )
        if not service_response.successful:
            add_diagnostic(diagnostics, active_stage, "failed", stage_started)
            emit({"ok": False, "code": "thing_service_discovery_failed", "message": "Вход выполнен, но TP-Link не выдал адрес Thing Cloud API.", "diagnostics": diagnostics})
            return

        app_server = ""
        result = service_response.result or {}
        for service in result.get("serviceList", []):
            if service.get("serviceId") == "nbu.iot-app-server.app-v2":
                app_server = service.get("serviceUrl") or ""
                break
        host = valid_thing_host(app_server)
        add_diagnostic(diagnostics, active_stage, "success", stage_started)

        session = requests.Session()
        session.verify = str(Path(__file__).with_name("tplink-cloud-server-ca.pem"))
        session.headers.update({
            "Authorization": "ut|" + token,
            "app-cid": "app:" + THING_APP + ":" + api._term_id,
            "x-app-name": THING_APP,
            "x-app-version": THING_VERSION,
            "x-term-id": api._term_id,
            "x-ospf": "Android 15",
            "x-net-type": "wifi",
            "x-strict": "0",
            "x-locale": "en_US",
            "x-app-brand": "TPLINK",
            "Accept": "application/json",
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": THING_APP + "/" + THING_VERSION + "(Homebridge/;Android 15)",
        })

        active_stage = "device_list"
        stage_started = time.monotonic()
        things = []
        for page in range(100):
            params = {
                "page": page, "pageSize": 100,
                "includeKasaShareDevices": "false",
                "includePcDevice": "false",
                "includeMatterDevice": "false",
                "includeExternalVendorDeviceInfo": "false",
            }
            response = session.get(host + "/v2/things", params=params, timeout=20, allow_redirects=False)
            response.raise_for_status()
            payload = response.json()
            problem = api_error(payload)
            if problem:
                raise RuntimeError(problem)
            page_items = payload.get("data") or []
            things.extend(page_items)
            total = int(payload.get("total") or 0)
            if len(page_items) < 100 or (total and len(things) >= total):
                break

        devices = []
        p110m = []
        for thing in things:
            model = str(thing.get("model") or thing.get("deviceModel") or "")
            name = thing.get("nickname") or thing.get("alias") or model or "Без имени"
            item = {
                "id": thing.get("thingName") or thing.get("deviceId"),
                "name": name,
                "model": model,
                "status": thing.get("status"),
                "category": thing.get("category") or thing.get("deviceType"),
            }
            devices.append(item)
            if "P110M" in model.upper() and item["id"]:
                p110m.append((thing, item))

        add_diagnostic(diagnostics, active_stage, "success", stage_started, count=len(devices))
        active_stage = "usage"
        readings = []
        for usage_index, (thing, item) in enumerate(p110m, start=1):
            usage_started = time.monotonic()
            try:
                thing_id = quote(str(item["id"]), safe="")
                response = session.get(host + "/v1/things/" + thing_id + "/usage",
                                        timeout=25, allow_redirects=False)
                response.raise_for_status()
                usage_response = response.json()
                problem = api_error(usage_response)
                if problem:
                    readings.append({"id": item["id"], "error": "TP-Link Thing API отклонил запрос показаний."})
                    add_diagnostic(diagnostics, "usage", "failed", usage_started, count=usage_index)
                    continue
                usage = usage_response.get("data", usage_response)
                readings.append({"id": item["id"], "usage": usage})
                add_diagnostic(diagnostics, "usage", "success", usage_started, count=usage_index)
            except requests.Timeout:
                readings.append({"id": item["id"], "error": "Облачный запрос показаний превысил лимит времени."})
                add_diagnostic(diagnostics, "usage", "failed", usage_started, count=usage_index)
            except Exception:
                readings.append({"id": item["id"], "error": "Не удалось прочитать энергопоказания из Thing Cloud API."})
                add_diagnostic(diagnostics, "usage", "failed", usage_started, count=usage_index)
        if not p110m:
            add_diagnostic(diagnostics, "usage", "skipped", time.monotonic())

        emit({
            "ok": True, "cloud": "tapo-thing-api", "authenticated": True,
            "deviceCount": len(devices), "devices": devices,
            "p110mCount": len(p110m), "readings": readings, "diagnostics": diagnostics,
            "message": "Авторизация и обнаружение устройств через Tapo Thing Cloud API выполнены. Запрошены только данные чтения; команды управления не отправлялись."
        })
    except TPLinkMFARequiredError:
        add_diagnostic(diagnostics, "authentication", "required", stage_started)
        emit({"ok": False, "code": "mfa_required", "message": "TP-Link запросил код подтверждения. Введите свежий код из письма и повторите проверку.", "diagnostics": diagnostics})
    except TPLinkAuthError:
        add_diagnostic(diagnostics, "authentication", "failed", stage_started)
        emit({"ok": False, "code": "auth_failed", "message": "TP-Link отклонил логин или пароль. Проверьте данные аккаунта.", "diagnostics": diagnostics})
    except TPLinkCloudError:
        add_diagnostic(diagnostics, active_stage, "failed", stage_started)
        emit({"ok": False, "code": "cloud_error", "message": "Ошибка авторизации или обращения к облаку TP-Link.", "diagnostics": diagnostics})
    except Exception:
        add_diagnostic(diagnostics, active_stage, "failed", stage_started)
        emit({"ok": False, "code": "thing_api_error", "message": "Не удалось получить список устройств или данные Thing Cloud API. Подробности скрыты.", "diagnostics": diagnostics})


if __name__ == "__main__":
    main()
