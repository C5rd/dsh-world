import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace
from adapter import MessageStore, watchConnected
from binding import WechatOffline
from sender import NativeSender


class PollComplete(Exception):
    pass


class ReconnectTest(unittest.TestCase):
    def test_offline_then_new_process_resumes_cursor_without_replaying_messages(self):
        old = dict(local_id=1, shard='m.db', sort_seq=10, type='文本', sender_username='wxid_owner', content='旧消息')
        new = {**old, 'local_id': 2, 'sort_seq': 11, 'content': '重开后刚到的消息'}
        oldDatabase = Mock(); oldDatabase.get_messages.side_effect = WechatOffline('微信退出')
        newDatabase = Mock(); newDatabase.get_messages.side_effect = lambda _chat,limit,offset=0: [new,old][offset:offset+limit]
        oldSend, newSend = Mock(), Mock()
        oldSend.processId, newSend.processId = 10, 20
        connector = Mock(side_effect=[WechatOffline('尚未登录'), (oldDatabase,oldSend), (newDatabase,newSend)])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root/'state.sqlite')
            store.baseline('private',10,[old])
            config = dict(chats=[dict(id='private')], selfId='wxid_bot', moduleFile=str(root/'wechat.json'), pollSeconds=0.5)
            jobs = []
            def enqueue(*_):
                jobs.append(dict(id='a'*64, accountId='wxid_bot', chatId='private', messages=[dict(type='text',text='听到了')]))
                return dict(text='留在家里')
            ask = Mock(side_effect=enqueue)
            report, sleep = Mock(), Mock()
            try:
                with patch('builtins.print') as logs, patch('adapter.time.sleep',side_effect=PollComplete), self.assertRaises(PollComplete):
                    watchConnected(config,root,store,connector,ask=ask,report=report,poll=lambda _: jobs.pop(0) if jobs else None,sleep=sleep)
                self.assertEqual(connector.call_count,3)
                self.assertEqual(sleep.call_count,2)
                self.assertEqual(sum('指定微信账号已离线' in str(call.args) for call in logs.call_args_list),2)
                ask.assert_called_once()
                self.assertEqual(ask.call_args.args[1]['text'],new['content'])
                newSend.assert_called_once()
                oldSend.assert_not_called()
                oldSend.close.assert_called_once()
                newSend.close.assert_called_once()
                self.assertEqual(store.cursor('private'),11)
                store.checkPending()
                self.assertTrue(store.seen('private','m.db:1'))
                report.assert_called_once()
            finally: store.close()

    def test_uncertain_message_and_non_connection_errors_never_auto_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            store.baseline('private',10)
            store.begin('private','m.db:11',11)
            connector,sleep=Mock(),Mock()
            try:
                with self.assertRaisesRegex(RuntimeError,'尚未确认'):
                    watchConnected({},root,store,connector,poll=lambda _: None,sleep=sleep)
                connector.assert_not_called();sleep.assert_not_called()
                store.acknowledge('private','m.db:11')
                connector.side_effect=RuntimeError('账号不唯一')
                with self.assertRaisesRegex(RuntimeError,'账号不唯一'):
                    watchConnected({},root,store,connector,poll=lambda _: None,sleep=sleep)
                connector.assert_called_once();sleep.assert_not_called()
            finally:store.close()

    def test_native_process_handle_is_closed_once(self):
        sender=object.__new__(NativeSender)
        sender.api=Mock();sender.api.CloseHandle.return_value=True;sender.handle=123
        sender.close();sender.close()
        sender.api.CloseHandle.assert_called_once_with(123)
        self.assertIsNone(sender.handle)

    def test_process_loss_during_send_remains_uncertain_without_a_second_connection(self):
        row=dict(local_id=2,shard='m.db',sort_seq=11,type='文本',sender_username='wxid_owner',content='在吗')
        database=Mock();database.get_messages.side_effect=lambda _chat,limit,offset=0:[row][offset:offset+limit]
        send=Mock(side_effect=WechatOffline('发送期间微信退出'));send.processId=10
        connector=Mock(return_value=(database,send))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            config=dict(chats=[dict(id='private')],selfId='wxid_bot',moduleFile=str(root/'wechat.json'))
            jobs=[]
            def enqueue(*_):
                jobs.append(dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='答复')]))
                return dict(text='留在家里')
            ask=Mock(side_effect=enqueue)
            report,sleep=Mock(),Mock()
            try:
                with self.assertRaisesRegex(RuntimeError,'发送未确认'):
                    watchConnected(config,root,store,connector,ask=ask,report=report,poll=lambda _:jobs.pop(0) if jobs else None,sleep=sleep)
                connector.assert_called_once();send.assert_called_once();ask.assert_called_once();sleep.assert_not_called()
                send.close.assert_called_once()
                with self.assertRaisesRegex(RuntimeError,'尚未确认'):store.checkPending()
                self.assertEqual(report.call_args.args[1]['status'],'uncertain')
            finally:store.close()

    def test_raw_message_read_rechecks_process_on_io_failure_without_swallowing_online_errors(self):
        from native import connect
        class Database:
            def __init__(self, **kwargs): self.account=kwargs['account'];self.wxid='wxid_bot'
            def _open_unlocked(self, _rel):return None
            def get_message_row(self, *_args, **_kwargs):return self._open_unlocked('message/message_0.db')
        process=SimpleNamespace(pid=10,create_time=lambda:100)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            config=dict(account='bot',selfId='wxid_bot',dbDir=directory,moduleFile=str(root/'wechat.json'))
            for offline in [False,True]:
                with self.subTest(offline=offline), patch('wechatauto.db.WeChatDB',Database), patch('native.findAccountProcess',return_value=process), patch('psutil.Process',return_value=process), patch('native.checkAccountProcess') as check, patch('native.checkedSnapshot',side_effect=FileNotFoundError('WAL disappeared')):
                    if offline:check.side_effect=[None,None,WechatOffline('微信退出')]
                    database,send=connect(config,root)
                    try:
                        with self.assertRaises(WechatOffline if offline else FileNotFoundError):
                            database.get_message_row('group',1)
                    finally:send.close()


if __name__ == '__main__':unittest.main()
