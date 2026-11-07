from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import threading
import webbrowser

HOST = "127.0.0.1"
PORT = 8000

class COIHandler(SimpleHTTPRequestHandler):
	def end_headers(self):
		self.send_header("Cross-Origin-Opener-Policy", "same-origin")
		self.send_header("Cross-Origin-Embedder-Policy", "require-corp")

		self.send_header("Cache-Control", "no-store")

		super().end_headers()


root = Path(__file__).resolve().parent / "src"
server = ThreadingHTTPServer((HOST, PORT), COIHandler)

import os
os.chdir(root)

url = f"http://{HOST}:{PORT}/webgpu-smoke.html"

print(f"dir: {root}")
print(f"server: {url}")
print("to stop close or Ctrl+C.")

threading.Timer(0.5, lambda: webbrowser.open(url)).start()

try:
	server.serve_forever()
except KeyboardInterrupt:
	print("\nstop...")
finally:
	server.server_close()
