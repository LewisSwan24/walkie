# Reference implementation of the walkie link (frames.md). Writes vectors.json beside this file;
# the bridge's tests and the firmware's host tests both check themselves against it.
# Standard library only: python protocol/gen_vectors.py
import binascii
import json
import math
import pathlib
import struct

MAX_PAYLOAD, MAX_CHUNK = 1024, 1100


def cobs_encode(data):
    out = bytearray(len(data) + len(data) // 254 + 2)
    enc, codep, code = 1, 0, 1
    for i, b in enumerate(data):
        if b:
            out[enc] = b
            enc += 1
            code += 1
        if not b or code == 0xFF:
            out[codep] = code
            code, codep = 1, enc
            if not b or i < len(data) - 1:
                enc += 1
    out[codep] = code
    return bytes(out[:enc])


def cobs_decode(enc):
    out, r = bytearray(), 0
    while r < len(enc):
        code = enc[r]
        r += 1
        if code == 0:
            return None
        for _ in range(code - 1):
            if r >= len(enc) or enc[r] == 0:
                return None
            out.append(enc[r])
            r += 1
        if code != 0xFF and r < len(enc):
            out.append(0)
    return bytes(out)


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def envelope(t, flags, seq, payload):
    head = struct.pack('<BBHH', t, flags, seq, len(payload)) + payload
    return head + struct.pack('<H', crc16(head))


def wire(t, flags, seq, payload):
    return b'\x00' + cobs_encode(envelope(t, flags, seq, payload)) + b'\x00'


def decode_chunk(chunk):
    if len(chunk) > MAX_CHUNK:
        return None
    env = cobs_decode(chunk)
    if env is None or len(env) < 8:
        return None
    t, flags, seq, n = struct.unpack_from('<BBHH', env)
    if n > MAX_PAYLOAD or n != len(env) - 8:
        return None
    if struct.unpack_from('<H', env, 6 + n)[0] != crc16(env[:6 + n]):
        return None
    return t, flags, seq, env[6:6 + n]


def decode_stream(chunks):
    frames, bad, cur = [], 0, bytearray()
    for data in chunks:
        for b in data:
            if b:
                cur.append(b)
                continue
            if cur:
                f = decode_chunk(bytes(cur))
                if f:
                    frames.append(f)
                else:
                    bad += 1
            cur = bytearray()
    return ','.join('%02x:%d' % (f[0], f[2]) for f in frames), bad


def h(b):
    return b.hex()


# COBS examples from the Wikipedia article (delimiter removed); the encoder must reproduce them.
run = lambda a, b: bytes(range(a, b))
wiki = [
    ('00', '0101'), ('0000', '010101'), ('001100', '01021101'), ('11220033', '0311220233'),
    ('11223344', '0511223344'), ('11000000', '0211010101'),
    (h(run(1, 255)), 'ff' + h(run(1, 255))),
    ('00' + h(run(1, 255)), '01ff' + h(run(1, 255))),
    (h(run(1, 256)), 'ff' + h(run(1, 255)) + '02ff'),
    (h(run(2, 256)) + '00', 'ff' + h(run(2, 256)) + '0101'),
    (h(run(3, 256)) + '0001', 'fe' + h(run(3, 256)) + '0201'),
]
cobs = [{'decoded': '', 'encoded': '01'}]
for dec, enc in wiki:
    assert h(cobs_encode(bytes.fromhex(dec))) == enc, dec[:16]
    assert h(cobs_decode(bytes.fromhex(enc))) == dec, enc[:16]
    cobs.append({'decoded': dec, 'encoded': enc})
cobs_invalid = ['051122', '0200', '03110022', '00']
assert all(cobs_decode(bytes.fromhex(x)) is None for x in cobs_invalid)

big = bytes((i * 37) & 0xFF for i in range(1024))  # zeros every 256 bytes, runs of 255 non-zero bytes
NONCE = 0x5EED1234
frames = []
for name, t, f, s, p in [
    ('hello from bridge', 0x01, 0, 0, bytes([1]) + struct.pack('<I', NONCE)),
    ('ping', 0x02, 0, 7, struct.pack('<I', 0x12345678)),
    ('audio down end of stream, empty', 0x11, 1, 65535, b''),
    ('audio up end of a spoken reason', 0x10, 9, 300, run(1, 21)),
    ('credit', 0x12, 0, 42, struct.pack('<I', 12288)),
    ('log in utf-8', 0x3F, 0, 3, '你好 walkie'.encode('utf-8')),
    ('audio down, largest payload', 0x11, 0, 513, big),
]:
    w = wire(t, f, s, p)
    assert decode_stream([w]) == ('%02x:%d' % (t, s), 0)
    frames.append({'name': name, 'type': t, 'flags': f, 'seq': s, 'payload': h(p), 'wire': h(w)})

pong = wire(0x03, 0, 8, struct.pack('<IIII', 0x12345678, 5000, 1, 2))
log = wire(0x3F, 0, 9, b'boot')
up = wire(0x10, 1, 10, run(1, 11))
bad_pong = bytearray(pong)
bad_pong[len(pong) // 2] ^= 0x40  # a flipped bit inside the COBS body
rom = b'ESP-ROM:esp32s3-20210327\r\nrst:0x15 (USB_UART_CHIP_RESET)\r\n'
bad_len = struct.pack('<BBHH', 0x3F, 0, 1, 5) + b'ab'
streams = []
for name, chunks, expect, bad in [
    ('boot text before a frame', [rom + pong], '03:8', 1),
    ('frame split across three reads', [pong[:3], pong[3:11], pong[11:]], '03:8', 0),
    ('three frames in one read', [pong + log + up], '03:8,3f:9,10:10', 0),
    ('corrupted frame then a good one', [bytes(bad_pong) + log], '3f:9', 1),
    ('oversized garbage then a good frame', [b'\x00' + b'\x41' * 1200 + log], '3f:9', 1),
    ('only delimiters', [b'\x00\x00\x00', b'\x00'], '', 0),
    ('valid COBS but too short for a frame', [bytes.fromhex('0003010200')], '', 1),
    ('length field disagrees with the data',
     [b'\x00' + cobs_encode(bad_len + struct.pack('<H', crc16(bad_len))) + b'\x00'], '', 1),
    ('payload over 1024 bytes', [wire(0x11, 0, 1, bytes(1026))], '', 1),
]:
    assert decode_stream(chunks) == (expect, bad), name
    streams.append({'name': name, 'chunks': [h(c) for c in chunks], 'expect': expect, 'bad': bad})

def ui(state, project=None, text=None, elapsed=None):
    # state, then the fields that are present, in tag order: 1 PROJECT, 2 TEXT (UTF-8), 3 ELAPSED_MS (u32)
    out = bytes([state])
    for tag, body in [(1, project and project.encode()), (2, text and text.encode()),
                      (3, None if elapsed is None else struct.pack('<I', elapsed))]:
        if body is not None:
            out += bytes([tag]) + struct.pack('<H', len(body)) + body
    return out


def approval_req(id_, tool, preview):
    t = tool.encode()
    return struct.pack('<HB', id_, len(t)) + t + preview.encode()


def test_keys(steps):
    return bytes([2, len(steps)]) + b''.join(struct.pack('<HB', d, m) for d, m in steps)


PCM8 = bytes([0x01, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x34, 0x12])
PAIR_KEY = bytes(range(0x40, 0x60))
PIX4 = bytes([0x1F, 0x00, 0xE0, 0x07])
messages = []
for name, t, d, p, fields in [
    ('hello_bridge', 0x01, 'down', bytes([1]) + struct.pack('<I', NONCE), {'proto': 1, 'nonce': NONCE}),
    ('hello_device', 0x01, 'up', struct.pack('<BBHHIII', 1, 0, 16000, 24000, 2097152, 123456, NONCE) + b'0.1.0',
     {'proto': 1, 'upRate': 16000, 'downRate': 24000, 'ringBytes': 2097152, 'uptimeMs': 123456, 'nonce': NONCE,
      'version': '0.1.0'}),
    ('hello_device_v2', 0x01, 'up',
     struct.pack('<BBHHIIIIB', 2, 0, 16000, 24000, 2097152, 123456, NONCE, 0x0A0B0C0D, 3) + b'0.2.0',
     {'proto': 2, 'upRate': 16000, 'downRate': 24000, 'ringBytes': 2097152, 'uptimeMs': 123456, 'nonce': NONCE,
      'nonceS': 0x0A0B0C0D, 'paired': True, 'adpcm': True, 'version': '0.2.0'}),
    ('ping', 0x02, 'down', struct.pack('<I', 0x12345678), {'token': 0x12345678}),
    ('pong', 0x03, 'up', struct.pack('<IIII', 0x12345678, 5000, 1, 2),
     {'token': 0x12345678, 'uptimeMs': 5000, 'badChunks': 1, 'seqGaps': 2}),
    ('credit', 0x12, 'up', struct.pack('<I', 12288), {'bytes': 12288}),
    ('played', 0x13, 'up', struct.pack('<IIIIB', 480000, 0xCBF43926, 3, 12288, 1),
     {'bytes': 480000, 'crc32': 0xCBF43926, 'underruns': 3, 'maxFill': 12288, 'reason': 1}),
    ('cmd_set_volume', 0x30, 'down', bytes([1, 200]), {'op': 1, 'arg': 200}),
    ('cmd_set_mic_gain', 0x30, 'down', bytes([2, 4]), {'op': 2, 'arg': 4}),
    ('cmd_stop_audio', 0x30, 'down', bytes([3]), {'op': 3, 'arg': 0}),
    ('cmd_boot_app0', 0x30, 'down', bytes([4]), {'op': 4, 'arg': 0}),
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('cmd_set_codec', 0x30, 'down', bytes([6, 1]), {'op': 6, 'arg': 1}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
    ('ui_idle', 0x20, 'down', ui(0, project='walkie'), {'state': 0, 'project': 'walkie'}),
    ('ui_confirm', 0x20, 'down', ui(2, project='walkie', text='把这个手环项目的代码优化一下'),
     {'state': 2, 'project': 'walkie', 'text': '把这个手环项目的代码优化一下'}),
    ('ui_working', 0x20, 'down', ui(3, project='walkie', text='Bash: npm test', elapsed=12500),
     {'state': 3, 'project': 'walkie', 'text': 'Bash: npm test', 'elapsedMs': 12500}),
    ('ui_error', 0x20, 'down', ui(5, text='Claude 登录过期，回电脑上登录'),
     {'state': 5, 'text': 'Claude 登录过期，回电脑上登录'}),
    ('approval_req', 0x22, 'down', approval_req(7, 'Write', '写入 out.txt\n内容: ok'),
     {'id': 7, 'tool': 'Write', 'preview': '写入 out.txt\n内容: ok'}),
    ('test_keys', 0x31, 'down', test_keys([(0, 1), (50, 3), (3000, 0)]),
     {'op': 2, 'steps': [{'delayMs': 0, 'mask': 1}, {'delayMs': 50, 'mask': 3}, {'delayMs': 3000, 'mask': 0}]}),
    ('test_mic_source_on', 0x31, 'down', bytes([3, 1]), {'op': 3, 'on': True}),
    ('test_mic_pcm', 0x31, 'down', bytes([4]) + PCM8, {'op': 4, 'pcm': h(PCM8)}),
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('test_selftest', 0x31, 'down', bytes([6]), {'op': 6}),
    ('pair_set', 0x32, 'down', bytes([1]) + PAIR_KEY, {'op': 1, 'key': h(PAIR_KEY)}),
    ('pair_forget', 0x32, 'down', bytes([2]), {'op': 2}),
    ('pair_ok_set', 0x32, 'up', bytes([3, 1]), {'op': 3, 'answered': 1}),
    ('pair_denied_forget', 0x32, 'up', bytes([4, 2]), {'op': 4, 'answered': 2}),
    ('button_cancel', 0x21, 'up', bytes([1]), {'event': 1}),
    ('button_stop', 0x21, 'up', bytes([2]), {'event': 2}),
    ('button_dismiss', 0x21, 'up', bytes([3]), {'event': 3}),
    ('button_switching', 0x21, 'up', bytes([4]), {'event': 4}),
    ('approval_res_allow', 0x23, 'up', struct.pack('<HBB', 7, 1, 0), {'id': 7, 'allow': True, 'reasonFollows': False}),
    ('approval_res_deny_reason', 0x23, 'up', struct.pack('<HBB', 7, 0, 1), {'id': 7, 'allow': False, 'reasonFollows': True}),
    ('test_snap_chunk', 0x31, 'up', bytes([5]) + struct.pack('<HHHH', 3, 65, 240, 135) + PIX4,
     {'op': 5, 'index': 3, 'count': 65, 'width': 240, 'height': 135, 'pixels': h(PIX4)}),
]:
    messages.append({'name': name, 'type': t, 'dir': d, 'hex': h(p), 'fields': fields})

# IMA-ADPCM, 4 bits a sample (frames.md, "Audio codec"). A frame is a 4-byte header, then the nibbles of samples 1 to n-1,
# the first sample's nibble in the low half of a byte. The header holds sample 0 as s16, the step index in effect for
# sample 1, and 1 when the last nibble is padding (n - 1 is odd), so a frame never depends on the one before it.
ADPCM_STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
    1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
    7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8]
assert len(ADPCM_STEPS) == 89


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def adpcm_encode(samples, index):
    pred, nibbles, index_in = samples[0], [], index
    for s in samples[1:]:
        step = ADPCM_STEPS[index]
        diff, nib = s - pred, 0
        if diff < 0:
            nib, diff = 8, -diff
        if diff >= step:
            nib |= 4
            diff -= step
        if diff >= step >> 1:
            nib |= 2
            diff -= step >> 1
        if diff >= step >> 2:
            nib |= 1
        diffq = step >> 3
        if nib & 4:
            diffq += step
        if nib & 2:
            diffq += step >> 1
        if nib & 1:
            diffq += step >> 2
        pred = clamp(pred - diffq if nib & 8 else pred + diffq, -32768, 32767)
        index = clamp(index + ADPCM_INDEX[nib & 7], 0, 88)
        nibbles.append(nib)
    pad = len(nibbles) % 2
    if pad:
        nibbles.append(0)
    body = bytes(nibbles[i] | (nibbles[i + 1] << 4) for i in range(0, len(nibbles), 2))
    return struct.pack('<hBB', samples[0], index_in, pad) + body, index


def adpcm_decode(frame):
    pred, index, pad = struct.unpack('<hBB', frame[:4])
    out = [pred]
    nibbles = []
    for b in frame[4:]:
        nibbles += [b & 15, b >> 4]
    if pad:
        nibbles.pop()
    for nib in nibbles:
        step = ADPCM_STEPS[index]
        diffq = step >> 3
        if nib & 4:
            diffq += step
        if nib & 2:
            diffq += step >> 1
        if nib & 1:
            diffq += step >> 2
        pred = clamp(pred - diffq if nib & 8 else pred + diffq, -32768, 32767)
        index = clamp(index + ADPCM_INDEX[nib & 7], 0, 88)
        out.append(pred)
    return out


def adpcm_case(name, samples, index_in):
    frame, index_out = adpcm_encode(samples, index_in)
    return {'name': name, 'pcm': h(struct.pack('<%dh' % len(samples), *samples)), 'indexIn': index_in, 'frame': h(frame),
            'indexOut': index_out, 'decoded': h(struct.pack('<%dh' % len(samples), *adpcm_decode(frame)))}


lcg, noise = 12345, []
for _ in range(100):
    lcg = (lcg * 1103515245 + 12345) & 0x7FFFFFFF
    noise.append((lcg >> 8) % 65536 - 32768)
adpcm = {
    'steps': ADPCM_STEPS,
    'indexTable': ADPCM_INDEX,
    'cases': [
        adpcm_case('silence, 20 ms at 16 kHz', [0] * 320, 0),
        adpcm_case('a 440 Hz tone, 20 ms at 16 kHz', [int(12000 * math.sin(2 * math.pi * 440 * k / 16000)) for k in range(320)], 0),
        adpcm_case('a 300 Hz tone, 20 ms at 24 kHz, a step index of 20', [int(9000 * math.sin(2 * math.pi * 300 * k / 24000)) for k in range(480)], 20),
        adpcm_case('full-scale square wave, the steps at their largest', [32767 if (k // 8) % 2 == 0 else -32768 for k in range(320)], 88),
        adpcm_case('full-scale square wave from the smallest step', [32767 if (k // 8) % 2 == 0 else -32768 for k in range(320)], 0),
        adpcm_case('one sample', [1234], 10),
        adpcm_case('two samples, the last nibble is padding', [100, -100], 5),
        adpcm_case('three samples', [-5, 300, 20000], 40),
        adpcm_case('noise over the whole range', noise, 30),
    ],
}
assert all(len(c['frame']) // 2 == 4 + (len(c['pcm']) // 4) // 2 for c in adpcm['cases'])

digits = b'123456789'
ping_head = envelope(0x02, 0, 7, struct.pack('<I', 0x12345678))[:-2]
vectors = {
    'crc16': [{'hex': h(digits), 'crc': crc16(digits)}, {'hex': '', 'crc': 0xFFFF},
              {'hex': h(ping_head), 'crc': crc16(ping_head)}],
    'crc32': [{'hex': h(digits), 'crc': binascii.crc32(digits)}, {'hex': '', 'crc': 0},
              {'hex': h(big), 'crc': binascii.crc32(big)}],
    'cobs': cobs,
    'cobsInvalid': cobs_invalid,
    'frames': frames,
    'streams': streams,
    'messages': messages,
    'adpcm': adpcm,
    'pattern': {'first8': h(b''.join(struct.pack('<H', (k * 1103 + 12345) & 0xFFFF) for k in range(8))),
                'at80000': (80000 * 1103 + 12345) & 0xFFFF},
}
assert vectors['crc16'][0]['crc'] == 0x29B1 and vectors['crc32'][0]['crc'] == 0xCBF43926
out = pathlib.Path(__file__).with_name('vectors.json')
out.write_text(json.dumps(vectors, indent=1) + '\n', encoding='utf-8', newline='\n')
print('wrote %s: %d cobs, %d frames, %d streams, %d messages'
      % (out.name, len(cobs), len(frames), len(streams), len(messages)))
