#!/usr/bin/env python3
"""Native llama.cpp measurements: no estimated token counts or shell timing TPS."""
import json, os, statistics, sys, time, urllib.request
from pathlib import Path


def request(base, payload):
    started = time.perf_counter()
    req = urllib.request.Request(base + '/v1/chat/completions', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
    first = None
    content = ''
    final = {}
    with urllib.request.urlopen(req, timeout=120) as response:
        for line in response:
            if not line.startswith(b'data: '):
                continue
            raw = line[6:].strip()
            if raw == b'[DONE]':
                break
            event = json.loads(raw)
            delta = (event.get('choices') or [{}])[0].get('delta', {}).get('content', '')
            if delta:
                first = first or time.perf_counter()
                content += delta
            if event.get('timings'):
                final = event
    timings = final.get('timings', {})
    count = timings.get('predicted_n')
    duration = timings.get('predicted_ms')
    if not isinstance(count, (int, float)) or not isinstance(duration, (int, float)) or count < 16 or duration <= 0:
        raise RuntimeError('No valid native decode counters were returned; throughput is unmeasured')
    if first is None:
        raise RuntimeError('No content token observed; TTFT is unmeasured')
    return {'decode_tokens': count, 'decode_ms': duration, 'decode_tps': count * 1000 / duration,
            'prompt_tokens': timings.get('prompt_n'), 'prompt_ms': timings.get('prompt_ms'),
            'prompt_tps': timings.get('prompt_per_second'), 'ttft_ms': (first-started)*1000,
            'wall_ms': (time.perf_counter()-started)*1000, 'content': content}


def benchmark(base, model):
    if not base.startswith(('http://127.0.0.1:', 'http://localhost:')):
        raise RuntimeError('This benchmark requires the verified local runtime; hosted benchmarks need explicit authorization')
    with urllib.request.urlopen(base + '/health', timeout=10) as response:
        health = json.load(response)
    if health.get('status') != 'ok':
        raise RuntimeError('Local runtime is not ready')
    with urllib.request.urlopen(base + '/v1/models', timeout=10) as response:
        identities = json.load(response).get('data', [])
    if model not in [item.get('id') for item in identities]:
        raise RuntimeError('Selected and served model identities disagree')
    workloads = {
        'decode': 'Write a detailed practical guide to organizing a personal workspace, at least 500 words.',
        'long_context': ('Reference note: keep verified facts separate from guesses. ' * 700) + '\nSummarize the reference and explain a practical verification workflow in at least 500 words.',
        'tool_selection': 'Return JSON specifying a read-only filesystem listing action, followed by a detailed explanation of why listing is appropriate. Do not claim you executed it. Use at least 200 words.'}
    results = {}
    for name, prompt in workloads.items():
        payload = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0,
                   'max_tokens': 256, 'stream': True, 'stream_options': {'include_usage': True}, 'cache_prompt': True}
        request(base, payload)  # excluded warmup
        samples = [request(base, payload) for _ in range(5)]
        results[name] = {'samples': samples, 'median_decode_tps': statistics.median(s['decode_tps'] for s in samples),
                         'median_ttft_ms': statistics.median(s['ttft_ms'] for s in samples)}
    return {'schema_version': 1, 'model': model, 'endpoint': base, 'machine': os.uname().nodename,
            'measured_at_unix_ms': int(time.time()*1000), 'warmups_per_workload': 1, 'samples_per_workload': 5,
            'native_counters_only': True, 'workloads': results,
            'quality_note': 'Tool-selection workload is a throughput sample; actual HII action quality requires separate interactive evaluations.'}


if __name__ == '__main__':
    try:
        result = benchmark(sys.argv[1].rstrip('/'), sys.argv[2])
        destination = Path(sys.argv[3])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(result, indent=2))
        print(json.dumps({'model': result['model'], 'machine': result['machine'], 'evidence': str(destination),
                          'measurements': {name: {k: v for k, v in data.items() if k != 'samples'} for name, data in result['workloads'].items()}}))
    except Exception as error:
        print('BENCHMARK_UNMEASURED: ' + str(error), file=sys.stderr)
        sys.exit(1)
