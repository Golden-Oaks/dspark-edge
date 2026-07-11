#!/usr/bin/env python3
"""
Fake remote DSpark drafter for Milestone 5 testing.

This gRPC server ignores feature contents and returns hardcoded token IDs.
It lets you test the server's draft-remote-dspark integration without a
real DSpark GGUF.

Generate Python stubs first:
  python3 -m grpc_tools.protoc \
    -I proto \
    --python_out=tests \
    --grpc_python_out=tests \
    proto/dspark.proto

Run:
  python3 tests/fake_drafter.py --port 50051
"""

import argparse
import sys
from concurrent import futures

import grpc

try:
    import dspark_pb2
    import dspark_pb2_grpc
except ImportError:
    print("error: generated protobuf stubs not found.")
    print("run: python3 -m grpc_tools.protoc -I proto --python_out=tests --grpc_python_out=tests proto/dspark.proto")
    sys.exit(1)


class FakeDrafter(dspark_pb2_grpc.DSparkDraftServiceServicer):
    def __init__(self, tokens):
        self.tokens = tokens
        self.session_count = 0

    def InitSession(self, request, context):
        self.session_count += 1
        return dspark_pb2.InitSessionResponse(
            session_id=self.session_count,
            ok=True,
            message="fake",
            draft_model_id="fake-dspark",
            target_layer_ids=[1, 9, 17, 25, 33],
            hidden_size=2560,
            block_size=7,
            feature_dtype="bf16",
        )

    def Prefill(self, request, context):
        return dspark_pb2.PrefillResponse(ok=True, n_positions=len(request.tokens))

    def Draft(self, request, context):
        return dspark_pb2.DraftResponse(
            session_id=request.session_id,
            step_id=request.step_id,
            draft_tokens=self.tokens,
            draft_logprobs=[0.0] * len(self.tokens),
            ok=True,
        )

    def Reset(self, request, context):
        return dspark_pb2.ResetResponse(ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=50051)
    parser.add_argument("--tokens", type=lambda s: [int(x) for x in s.split(",")], default=[100, 200, 300])
    args = parser.parse_args()

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    dspark_pb2_grpc.add_DSparkDraftServiceServicer_to_server(FakeDrafter(args.tokens), server)
    server.add_insecure_port(f"{args.host}:{args.port}")
    server.start()
    print(f"fake drafter listening on {args.host}:{args.port}")
    print(f"returning tokens: {args.tokens}")
    server.wait_for_termination()


if __name__ == "__main__":
    main()
