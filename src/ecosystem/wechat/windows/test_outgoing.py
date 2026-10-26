import tempfile
import unittest
from pathlib import Path
from outgoing import deliverMessages, mediaDigestMatches, prepareMessages, serverConfirmed


class OutgoingTest(unittest.TestCase):
    def test_a_local_outbox_row_is_not_a_server_confirmation(self):
        self.assertFalse(serverConfirmed(dict(server_id=0)))
        self.assertFalse(serverConfirmed({}))
        self.assertTrue(serverConfirmed(dict(server_id=5489465419718876343)))

    def test_media_receipt_uses_decoded_xml_when_raw_payload_is_compressed(self):
        digest = '2402bd4f44806c29a471639c1f3f584a'
        row = dict(content=f'<msg><emoji md5="{digest}" type="2"/></msg>')
        raw = dict(content=b'\x28\xb5\x2f\xfdcompressed-xml', packed_info=b'\x08\x02\x10\x01')
        self.assertTrue(mediaDigestMatches(row, digest, raw))
        self.assertFalse(mediaDigestMatches(row, '0' * 32, raw))
        self.assertTrue(mediaDigestMatches(dict(content=''), digest, dict(packed_info=bytes.fromhex(digest))))

    def test_partial_failure_keeps_order_and_never_retries(self):
        calls = []
        confirmed = []
        def send(message):
            calls.append(message)
            if message['type'] == 'sticker':
                raise RuntimeError('uncertain')
        items = [dict(type='text', text='一句'), dict(type='sticker', path='a.gif'), dict(type='text', text='下一句')]
        with self.assertRaisesRegex(RuntimeError, '第 2/3 条'):
            deliverMessages(items, send, confirmed.append)
        self.assertEqual(calls, items[:2])
        self.assertEqual(confirmed, [1])

    def test_all_messages_are_validated_before_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                prepareMessages([dict(type='text', text='ok'), dict(type='image', path='C:/outside.png')], {}, Path(directory))
            with self.assertRaises(ValueError):
                prepareMessages([dict(type='text', text='鱼' * 1400)], {}, Path(directory))

    def test_sticker_keeps_animation_and_creates_a_native_gif(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'reaction.webp'
            Image.new('RGB', (32,32), 'blue').save(source, format='WEBP', save_all=True, append_images=[Image.new('RGB', (32,32), 'red')], duration=100, loop=0)
            prepared = prepareMessages([dict(type='sticker', path=str(source))], dict(mediaRoots=[directory]), root)
            with Image.open(prepared[0]['path']) as output:
                self.assertEqual(output.format, 'GIF')
                self.assertEqual(output.n_frames, 2)


if __name__ == '__main__':
    unittest.main()
