#!/usr/bin/env python3
"""開発用のローカルサーバー。

`python3 -m http.server` はキャッシュ制御のヘッダを一切送らないため、
CSS や JS を書き換えてもブラウザが古いファイルを使い続けることがある
（リロードしても直らず、原因が分かりにくい）。

このサーバーは毎回「保存しないで」と伝えるヘッダを付けて配信するので、
リロードすれば必ず最新のファイルが反映される。

127.0.0.1 のみで待ち受けるため、同じネットワークの他人からは見えない。
"""
import http.server

PORT = 5500
HOST = '127.0.0.1'


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    print(f'開発サーバーを起動しました → http://localhost:{PORT}')
    print('停止するには Ctrl+C を押してください')
    http.server.test(HandlerClass=NoCacheHandler, port=PORT, bind=HOST)
