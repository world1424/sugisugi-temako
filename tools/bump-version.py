#!/usr/bin/env python3
"""index.html の CSS / JS のバージョン番号を1つ上げる。

GitHub Pages は CSS や JS を約10分キャッシュするため、更新しても
すぐには反映されず、すでに開いたことがある端末では古い画面が出る。
読み込みURLの ?v= を変えるとURL自体が変わるので、必ず最新が読まれる。

使い方:  npm run bump   （公開前に実行する）
"""
import pathlib
import re

INDEX = pathlib.Path(__file__).resolve().parent.parent / 'index.html'


def main():
    html = INDEX.read_text(encoding='utf-8')
    versions = [int(v) for v in re.findall(r'\?v=(\d+)', html)]
    if not versions:
        print('?v= が見つかりませんでした。index.html を確認してください。')
        return 1
    nxt = max(versions) + 1
    updated = re.sub(r'\?v=\d+', f'?v={nxt}', html)
    INDEX.write_text(updated, encoding='utf-8')
    print(f'バージョンを {max(versions)} → {nxt} に更新しました（{len(versions)}箇所）')
    print('この後 git commit して push すると、全員にすぐ反映されます。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
