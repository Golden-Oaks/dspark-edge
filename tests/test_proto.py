#!/usr/bin/env python3
"""
Protocol-level smoke tests for dspark.proto.

Generate Python stubs first:
  python3 -m grpc_tools.protoc \
    -I proto \
    --python_out=tests \
    --grpc_python_out=tests \
    proto/dspark.proto

Run:
  python3 tests/test_proto.py
"""

import sys
import tempfile

try:
    import dspark_pb2
except ImportError:
    print("error: generated protobuf stubs not found.")
    print("run: python3 -m grpc_tools.protoc -I proto --python_out=tests --grpc_python_out=tests proto/dspark.proto")
    sys.exit(1)


def test_init_roundtrip():
    req = dspark_pb2.InitSessionRequest(
        target_model_id="Qwen/Qwen3-4B",
        tokenizer_hash="deadbeef",
    )
    data = req.SerializeToString()
    req2 = dspark_pb2.InitSessionRequest()
    req2.ParseFromString(data)
    assert req2.target_model_id == req.target_model_id
    print("ok: InitSession roundtrip")


def test_draft_roundtrip():
    tf = dspark_pb2.TokenFeatures(
        token=42,
        position=7,
        features=b"\x00" * 25600,
    )
    req = dspark_pb2.DraftRequest(
        session_id=1,
        step_id=2,
        position=6,
        max_draft_tokens=7,
        greedy=True,
        accepted_tokens=[tf],
    )
    data = req.SerializeToString()
    req2 = dspark_pb2.DraftRequest()
    req2.ParseFromString(data)
    assert len(req2.accepted_tokens) == 1
    assert req2.accepted_tokens[0].token == 42
    assert req2.accepted_tokens[0].features == b"\x00" * 25600
    print("ok: DraftRequest roundtrip")


def test_response_roundtrip():
    resp = dspark_pb2.DraftResponse(
        session_id=1,
        step_id=2,
        draft_tokens=[100, 200, 300],
        draft_logprobs=[-1.0, -2.0, -3.0],
        confidence=[0.9, 0.8, 0.7],
        ok=True,
    )
    data = resp.SerializeToString()
    resp2 = dspark_pb2.DraftResponse()
    resp2.ParseFromString(data)
    assert list(resp2.draft_tokens) == [100, 200, 300]
    print("ok: DraftResponse roundtrip")


def test_golden_write():
    tf = dspark_pb2.TokenFeatures(token=1, position=0, features=b"\xab\xcd" * 10)
    prefill = dspark_pb2.PrefillRequest(session_id=1, tokens=[tf], last_chunk=True)
    with tempfile.NamedTemporaryFile(suffix=".pb", delete=False) as f:
        f.write(prefill.SerializeToString())
        print(f"ok: wrote golden sample to {f.name}")


if __name__ == "__main__":
    test_init_roundtrip()
    test_draft_roundtrip()
    test_response_roundtrip()
    test_golden_write()
    print("all proto tests passed")
