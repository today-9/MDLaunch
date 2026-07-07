"""起動ランチャー: 二重起動なら既存サーバーのタブを開くだけ"""
import os
import socket
import webbrowser

import uvicorn

PORT = int(os.environ.get("MDLAUNCH_PORT", "8321"))
URL = f"http://127.0.0.1:{PORT}"


def main() -> None:
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", PORT))
        probe.close()
    except OSError:
        # すでに起動中 → ブラウザを開くだけ
        webbrowser.open(URL)
        return
    os.environ["MDLAUNCH_OPEN"] = "1"
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT)


if __name__ == "__main__":
    main()
