import ctypes
import json
import tempfile
import unittest
from pathlib import Path
from sender import NativeRequest, encodeRequest, verifyFile


class SenderTest(unittest.TestCase):
    def test_request_abi_and_utf8_boundaries(self):
        profile = json.loads((Path(__file__).parent / 'engine/profile.json').read_text(encoding='utf-8-sig'))
        self.assertEqual(ctypes.sizeof(NativeRequest), 4464)
        request = encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, '你好')
        self.assertEqual(request.value, '你好'.encode())
        self.assertEqual(request.rva[0], 0x45d10)
        encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, 'a' * 4094)
        with self.assertRaises(ValueError):
            encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, 'a' * 4095)
        for invalid in ('a\0b', '鱼' * 1400):
            with self.assertRaises(ValueError):
                encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, invalid)
        with self.assertRaises(ValueError):
            encodeRequest(profile, 123, 'wxid_bot', 'not a wxid', 1, 'hello')

    def test_unknown_core_build_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Weixin.dll'
            path.write_bytes(b'unknown build')
            with self.assertRaises(ValueError):
                verifyFile(path, 201552944, '0' * 64)
            with self.assertRaises(ValueError):
                verifyFile(path, path.stat().st_size, '0' * 64)


if __name__ == '__main__':
    unittest.main()
