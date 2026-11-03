import importlib.util
import io
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('benchmark', 'scripts/hii-model-benchmark.py')
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)

class Response(io.BytesIO):
    pass

class NativeCounters(unittest.TestCase):
    def test_native_decode_denominator(self):
        stream = b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"timings":{"predicted_n":100,"predicted_ms":2000,"prompt_n":200,"prompt_ms":1000}}\n\ndata: [DONE]\n'
        with patch.object(benchmark.urllib.request, 'urlopen', return_value=Response(stream)):
            measured = benchmark.request('http://127.0.0.1:1234', {})
        self.assertEqual(measured['decode_tps'], 50)
        self.assertEqual(measured['decode_tokens'], 100)
        self.assertGreaterEqual(measured['ttft_ms'], 0)

    def test_missing_counters_are_unmeasured(self):
        stream = b'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"completion_tokens":100}}\n\ndata: [DONE]\n'
        with patch.object(benchmark.urllib.request, 'urlopen', return_value=Response(stream)):
            with self.assertRaisesRegex(RuntimeError, 'No valid native decode counters'):
                benchmark.request('http://127.0.0.1:1234', {})

if __name__ == '__main__':
    unittest.main()
