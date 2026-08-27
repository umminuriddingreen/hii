"""A minimal facade: discovery, framing, request/response over the named pipe.

Deliberately small and separate from the Rust client. This is an eval harness,
not the production facade — it exists so the model's own tool calls can be
executed against a live Rhino and then checked by reading the document back.
"""
import glob, json, os, struct, uuid

RUNTIME = os.path.join(os.path.expanduser("~"), ".hii", "rhino", "instances")
PROTOCOL_VERSION = 1


def discover():
    """The most recently advertised Rhino instance."""
    files = sorted(glob.glob(os.path.join(RUNTIME, "*.json")), key=os.path.getmtime)
    if not files:
        raise RuntimeError(f"no HII Rhino advertisement in {RUNTIME}; is the Hii command running?")
    with open(files[-1], encoding="utf-8") as handle:
        return json.load(handle)


class Bridge:
    """One connection. Operations are dotted names, as on the wire."""

    def __init__(self):
        self.advertisement = discover()
        name = self.advertisement["pipe_name"]
        self.pipe = open(rf"\\.\pipe\{name}", "r+b", buffering=0)
        self.counter = 0
        self.instance = self.advertisement["rhino_instance_id"]
        self._send({"envelope": "handshake", "protocol_version": PROTOCOL_VERSION,
                    "client": "hii-rhino-eval", "client_version": "0.1.0"})
        self.handshake = self._await("handshake")
        self.document = None

    # -- framing: little-endian u32 byte count, then UTF-8 JSON, no BOM ------
    def _send(self, message):
        payload = json.dumps(message).encode("utf-8")
        self.pipe.write(struct.pack("<I", len(payload)) + payload)

    def _read(self):
        header = self.pipe.read(4)
        if len(header) < 4:
            raise RuntimeError("the bridge closed the pipe")
        (length,) = struct.unpack("<I", header)
        body = b""
        while len(body) < length:
            chunk = self.pipe.read(length - len(body))
            if not chunk:
                raise RuntimeError("the bridge closed the pipe mid-message")
            body += chunk
        return json.loads(body.decode("utf-8"))

    def _await(self, envelope, request_id=None):
        """Skip events, which arrive unsolicited, until the awaited reply."""
        while True:
            message = self._read()
            if message["envelope"] == "event":
                continue
            if request_id and message.get("request_id") not in (request_id, None):
                continue
            if message["envelope"] == "error":
                raise BridgeError(message)
            if message["envelope"] == envelope:
                return message

    def use_active_document(self):
        session = self.request("rhino.session.describe")
        documents = session["documents"]
        if not documents:
            raise RuntimeError("Rhino has no open document")
        self.document = documents[0]["document_runtime_serial"]
        return session

    def request(self, operation, arguments=None, target="document"):
        self.counter += 1
        request_id = f"eval-{self.counter:08d}"
        if target == "document" and self.document is not None:
            ref = {"kind": "document", "rhino_instance_id": self.instance,
                   "document_runtime_serial": self.document}
        elif target is None:
            ref = None
        else:
            ref = {"kind": "instance", "rhino_instance_id": self.instance}
        message = {"envelope": "request", "protocol_version": PROTOCOL_VERSION,
                   "request_id": request_id, "operation": operation,
                   "arguments": arguments or {}, "timeout_ms": 30000}
        if ref:
            message["target"] = ref
        self._send(message)
        return self._await("response", request_id)["result"]

    def close(self):
        try:
            self.pipe.close()
        except OSError:
            pass


class BridgeError(RuntimeError):
    def __init__(self, envelope):
        super().__init__(f"{envelope['code']}: {envelope['message']}")
        self.code = envelope["code"]
        self.retry = envelope.get("retry")
