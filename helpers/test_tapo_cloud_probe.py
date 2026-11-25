import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("tapo_cloud_probe.py")
SPEC = importlib.util.spec_from_file_location("tapo_cloud_probe", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ThingCloudValidationTests(unittest.TestCase):
    def test_accepts_expected_regional_thing_host(self):
        self.assertEqual(
            MODULE.valid_thing_host("https://use1-app-server.iot.i.tplinkcloud.com/"),
            "https://use1-app-server.iot.i.tplinkcloud.com",
        )

    def test_rejects_non_tplink_host(self):
        with self.assertRaises(ValueError):
            MODULE.valid_thing_host("https://attacker.example.com")

    def test_rejects_http_host(self):
        with self.assertRaises(ValueError):
            MODULE.valid_thing_host("http://use1-app-server.iot.i.tplinkcloud.com")

    def test_rejects_host_with_port(self):
        with self.assertRaises(ValueError):
            MODULE.valid_thing_host("https://use1-app-server.iot.i.tplinkcloud.com:8443")

    def test_reports_cloud_api_error(self):
        self.assertIn("123", MODULE.api_error({"error_code": 123, "msg": "bad"}))

    def test_accepts_zero_error_code(self):
        self.assertIsNone(MODULE.api_error({"error_code": 0, "data": []}))


if __name__ == "__main__":
    unittest.main()
