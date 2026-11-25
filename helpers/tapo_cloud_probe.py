#!/usr/bin/env python3
"""Read-only Tapo cloud account and P110M energy diagnostic."""
import asyncio
import json
import sys

def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def main():
    try:
        data = json.load(sys.stdin)
        username = data.get("username")
        password = data.get("password")
        mfa_code = data.get("mfaCode") or ""
        if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
            emit({"ok": False, "code": "credentials_required", "message": "Укажите email и пароль аккаунта Tapo."})
            return
        from tplinkcloud.client import TPLinkApi
        from tplinkcloud.device_client import TPLinkDeviceClient
        from tplinkcloud.device_info import TPLinkDeviceInfo
        from tplinkcloud.exceptions import TPLinkAuthError, TPLinkCloudError, TPLinkMFARequiredError
    except ImportError:
        emit({"ok": False, "code": "dependency_missing", "message": "Не найдена библиотека tplink-cloud-api. Установите её в Python окружение Homebridge."})
        return
    except Exception:
        emit({"ok": False, "code": "invalid_input", "message": "Не удалось прочитать параметры проверки."})
        return

    try:
        api = TPLinkApi(cloud_type="tapo")
        callback = (lambda _kind, _email: mfa_code) if mfa_code else None
        auth = api.login(username.strip(), password, mfa_callback=callback)
        token = auth.get("token") if isinstance(auth, dict) else None
        if not token:
            emit({"ok": False, "code": "login_failed", "message": "TP-Link не вернул токен облачной сессии."})
            return
        raw_devices = api.get_device_info_list(token)
        devices = []
        targets = []
        for raw in raw_devices or []:
            info = TPLinkDeviceInfo(raw, cloud_type="tapo")
            model = str(info.device_model or "")
            item = {"id": info.device_id, "name": info.alias or info.device_name or "Без имени",
                    "model": model, "firmware": info.fw_ver, "status": info.status}
            devices.append(item)
            if "P110M" in model.upper():
                targets.append((info, item))
        readings = []
        for info, item in targets:
            client = TPLinkDeviceClient(info.app_server_url, token, term_id=api._term_id,
                access_key=api.access_key, secret_key=api.secret_key,
                app_name=api._app_name, cloud_type="tapo")
            try:
                response = asyncio.run(asyncio.wait_for(
                    client.pass_through_request(info.device_id, {"emeter": {"get_realtime": None}}), timeout=35))
                meter = response.get("emeter", {}).get("get_realtime", {}) if isinstance(response, dict) else {}
                if isinstance(meter, dict) and meter.get("err_code", 0) == 0:
                    fields = {key: meter[key] for key in
                        ("power_mw", "voltage_mv", "current_ma", "total_wh", "power", "voltage", "current", "total")
                        if key in meter and isinstance(meter[key], (int, float))}
                    reading = {"id": info.device_id, "name": item["name"], "model": item["model"], "fields": fields}
                    if isinstance(fields.get("power_mw"), (int, float)):
                        reading["powerW"] = fields["power_mw"] / 1000
                    readings.append(reading)
                else:
                    readings.append({"id": info.device_id, "name": item["name"], "model": item["model"],
                        "error": "Устройство не вернуло данные emeter.get_realtime.",
                        "deviceErrorCode": meter.get("err_code") if isinstance(meter, dict) else None})
            except asyncio.TimeoutError:
                readings.append({"id": info.device_id, "name": item["name"], "model": item["model"],
                    "error": "Нет ответа от устройства через облако за 35 секунд."})
            except Exception:
                readings.append({"id": info.device_id, "name": item["name"], "model": item["model"],
                    "error": "Облачный запрос энергии завершился ошибкой. Подробности скрыты."})
        emit({"ok": True, "cloud": "tapo", "authenticated": True, "deviceCount": len(devices),
            "devices": devices, "p110mCount": len(targets), "readings": readings,
            "message": "Вход в облако Tapo выполнен. Команды управления устройствами не отправлялись."})
    except TPLinkMFARequiredError:
        emit({"ok": False, "code": "mfa_required", "message": "TP-Link запросил код подтверждения. Введите свежий код из письма и повторите проверку."})
    except TPLinkAuthError:
        emit({"ok": False, "code": "auth_failed", "message": "TP-Link отклонил логин или пароль. Проверьте данные аккаунта."})
    except TPLinkCloudError:
        emit({"ok": False, "code": "cloud_error", "message": "Ошибка обращения к облаку TP-Link. Повторите проверку позже."})
    except Exception:
        emit({"ok": False, "code": "unexpected_error", "message": "Проверка завершилась ошибкой. Подробности, способные содержать секреты, скрыты."})

if __name__ == "__main__":
    main()
