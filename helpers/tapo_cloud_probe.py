#!/usr/bin/env python3
import json
import sys

def main():
    data = json.load(sys.stdin)
    from tplinkcloud.client import TPLinkApi\n    from tplinkcloud.device_client import TPLinkDeviceClient\n    from tplinkcloud.device_info import TPLinkDeviceInfo
    from tplinkcloud.exceptions import TPLinkAuthError, TPLinkCloudError, TPLinkMFARequiredError
    try:
        api = TPLinkApi(cloud_type="tapo")
        code = data.get("mfaCode") or ""
        callback = (lambda kind, email: code) if code else None
        result = api.login(data.get("username"), data.get("password"), mfa_callback=callback)
        devices = api.get_device_info_list(result["token"])
        print(json.dumps({"ok": True, "devices": [{"id": d.get("deviceId"), "name": d.get("alias"), "model": d.get("deviceModel")} for d in devices]}))
    except TPLinkMFARequiredError:
        print(json.dumps({"ok": False, "code": "mfa_required"}))
    except TPLinkAuthError:
        print(json.dumps({"ok": False, "code": "auth_failed"}))
    except TPLinkCloudError:
        print(json.dumps({"ok": False, "code": "cloud_error"}))

if __name__ == "__main__":
    main()
