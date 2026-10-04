// test_ui_messages.cpp: the payloads of UI, BUTTON, APPROVAL and the TEST hooks, against protocol/vectors.json, and what
// the parsers make of payloads that are cut short or carry what this version does not know.
#include <string.h>
#include <string>
#include "check.h"
#include "proto/messages.h"
#include "vectors.h"

static std::string vec(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(name, m.name) == 0) return m.hex;
  printf("no vector named %s\n", name);
  g_fail++;
  return "";
}
static std::string str(proto::Text t) { return std::string((const char*)t.p, t.n); }

TEST(buttonAndApprovalAnswersMatchVectors) {
  uint8_t out[64];
  size_t n = proto::buildButton(proto::BTN_CANCEL, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_cancel"), "button_cancel");
  n = proto::buildButton(proto::BTN_STOP, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_stop"), "button_stop");
  n = proto::buildButton(proto::BTN_DISMISS, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_dismiss"), "button_dismiss");
  n = proto::buildButton(proto::BTN_SWITCHING, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_switching"), "button_switching");
  n = proto::buildApprovalRes(7, true, false, out, sizeof out);
  CHECK(tohex(out, n) == vec("approval_res_allow"), "approval_res_allow");
  n = proto::buildApprovalRes(7, false, true, out, sizeof out);
  CHECK(tohex(out, n) == vec("approval_res_deny_reason"), "approval_res_deny_reason");
  CHECK(proto::buildApprovalRes(7, true, false, out, 3) == 0, "an answer into a short buffer");
  CHECK(proto::buildButton(1, out, 0) == 0, "a button into no buffer");
}

TEST(snapChunkMatchesTheVector) {
  uint8_t out[64];
  const uint8_t px[4] = {0x1F, 0x00, 0xE0, 0x07};
  size_t n = proto::buildSnapChunk(3, 65, 240, 135, px, 4, out, sizeof out);
  CHECK(tohex(out, n) == vec("test_snap_chunk"), "test_snap_chunk");
  CHECK(proto::buildSnapChunk(3, 65, 240, 135, px, 4, out, 12) == 0, "a chunk into a short buffer");
  uint8_t big[9 + 1000];
  uint8_t pix[1000] = {0};
  CHECK(proto::buildSnapChunk(0, 1, 240, 135, pix, 1000, big, sizeof big) == 1009, "a full chunk is 1009 bytes");
}

TEST(uiPayloadsParseToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("ui_idle").c_str());
  proto::UiView v;
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_IDLE && str(v.project) == "walkie" && v.text.n == 0 &&
            !v.hasElapsed,
        "ui_idle");
  b = unhex(vec("ui_confirm").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_CONFIRM &&
            str(v.text) == "\xe6\x8a\x8a\xe8\xbf\x99\xe4\xb8\xaa\xe6\x89\x8b\xe7\x8e\xaf\xe9\xa1\xb9\xe7\x9b\xae\xe7\x9a\x84\xe4\xbb\xa3\xe7\xa0\x81\xe4\xbc\x98\xe5\x8c\x96\xe4\xb8\x80\xe4\xb8\x8b",
        "ui_confirm");
  b = unhex(vec("ui_working").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_WORKING && str(v.text) == "Bash: npm test" &&
            v.hasElapsed && v.elapsedMs == 12500,
        "ui_working");
  b = unhex(vec("ui_error").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_ERROR && v.project.n == 0 && v.text.n > 0, "ui_error");
}

TEST(uiParserSkipsWhatItDoesNotKnowAndRefusesWhatIsCutShort) {
  proto::UiView v;
  const uint8_t unknown[] = {2, 9, 2, 0, 0xAA, 0xBB, 1, 2, 0, 'h', 'i'};  // CONFIRM, tag 9, then PROJECT "hi"
  CHECK(proto::parseUi(unknown, sizeof unknown, v) && v.state == proto::UI_CONFIRM && str(v.project) == "hi", "unknown tag");
  const uint8_t pastEnd[] = {2, 1, 5, 0, 'h'};
  CHECK(!proto::parseUi(pastEnd, sizeof pastEnd, v), "a field that runs past the end");
  const uint8_t oneTooLong[] = {2, 1, 2, 0, 'h'};
  CHECK(!proto::parseUi(oneTooLong, sizeof oneTooLong, v), "a field that is one byte longer than what is left");
  const uint8_t justFits[] = {2, 1, 1, 0, 'h'};
  CHECK(proto::parseUi(justFits, sizeof justFits, v) && str(v.project) == "h", "and one that is exactly what is left");
  const uint8_t shortHead[] = {2, 1, 5};
  CHECK(!proto::parseUi(shortHead, sizeof shortHead, v), "a field header that runs past the end");
  CHECK(!proto::parseUi(unknown, 0, v), "an empty payload");
  const uint8_t badState[] = {6};
  CHECK(!proto::parseUi(badState, 1, v), "a state that does not exist");
  const uint8_t oddTime[] = {3, 3, 2, 0, 1, 2};
  CHECK(proto::parseUi(oddTime, sizeof oddTime, v) && !v.hasElapsed, "a time that is not 4 bytes is ignored");
  const uint8_t bare[] = {1};
  v.project = {bare, 9};
  CHECK(proto::parseUi(bare, 1, v) && v.project.n == 0, "a bare state clears what the view held before");
}

TEST(approvalRequestParsesToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("approval_req").c_str());
  proto::ApprovalReq r;
  CHECK(proto::parseApprovalReq(b.data(), b.size(), r) && r.id == 7 && str(r.tool) == "Write" &&
            str(r.preview) == "\xe5\x86\x99\xe5\x85\xa5 out.txt\n\xe5\x86\x85\xe5\xae\xb9: ok",
        "approval_req");
  const uint8_t longTool[] = {1, 0, 9, 'a'};
  CHECK(!proto::parseApprovalReq(longTool, sizeof longTool, r), "a tool name longer than the payload");
  CHECK(!proto::parseApprovalReq(longTool, 2, r), "a payload without a tool length");
  const uint8_t noPreview[] = {1, 0, 1, 'x'};
  CHECK(proto::parseApprovalReq(noPreview, sizeof noPreview, r) && r.preview.n == 0, "no preview is fine");
}

TEST(testHooksParseToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("test_keys").c_str());
  proto::TestOp t = {0, nullptr, 0};
  proto::KeyStep steps[proto::KEY_STEPS_MAX];
  size_t count = 0;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_KEYS &&
            proto::parseKeys(t.args, t.len, steps, proto::KEY_STEPS_MAX, count) && count == 3 && steps[0].delayMs == 0 &&
            steps[0].mask == 1 && steps[1].delayMs == 50 && steps[1].mask == 3 && steps[2].delayMs == 3000 && steps[2].mask == 0,
        "test_keys");
  b = unhex(vec("test_mic_source_on").c_str());
  bool on = false;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_MIC_SOURCE && proto::parseMicSource(t.args, t.len, on) && on,
        "test_mic_source_on");
  b = unhex(vec("test_mic_pcm").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_MIC_PCM && t.len == 8 && t.args[2] == 0xFF, "test_mic_pcm");
  b = unhex(vec("test_snap").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_SNAP && t.len == 0, "test_snap");
}

TEST(keyScriptsOfTheWrongLengthAreRefused) {
  proto::KeyStep steps[proto::KEY_STEPS_MAX];
  size_t count = 0;
  const uint8_t none[] = {0};
  CHECK(!proto::parseKeys(none, sizeof none, steps, proto::KEY_STEPS_MAX, count), "no steps");
  const uint8_t oneShort[] = {2, 0, 0, 1};
  CHECK(!proto::parseKeys(oneShort, sizeof oneShort, steps, proto::KEY_STEPS_MAX, count), "two steps announced, one sent");
  const uint8_t extra[] = {1, 0, 0, 1, 0};
  CHECK(!proto::parseKeys(extra, sizeof extra, steps, proto::KEY_STEPS_MAX, count), "a byte too many");
  uint8_t seventeen[1 + 17 * 3] = {17};
  CHECK(!proto::parseKeys(seventeen, sizeof seventeen, steps, proto::KEY_STEPS_MAX, count), "more steps than the buffer");
  CHECK(!proto::parseKeys(none, 0, steps, proto::KEY_STEPS_MAX, count), "nothing at all");
  uint8_t sixteen[1 + 16 * 3] = {16};
  CHECK(proto::parseKeys(sixteen, sizeof sixteen, steps, proto::KEY_STEPS_MAX, count) && count == 16, "as many steps as the buffer holds");
  bool on = true;
  CHECK(!proto::parseMicSource(none, 0, on), "a mic source switch without its byte");
}

TEST(numbersAndFlagsAreReadWholeNotJustTheirLowByte) {
  const uint8_t pattern[] = {0x34, 0x12};
  uint16_t frames = 0;
  CHECK(proto::parseUpPattern(pattern, sizeof pattern, frames) && frames == 0x1234, "an up pattern of 4660 frames");
  CHECK(!proto::parseUpPattern(pattern, 1, frames), "half of one");
  const uint8_t two[] = {2}, zero[] = {0};
  bool on = false;
  CHECK(proto::parseMicSource(two, 1, on) && on, "any byte but 0 turns the source on");
  CHECK(proto::parseMicSource(zero, 1, on) && !on, "and 0 turns it off");
  const uint8_t req[] = {0x07, 0x01, 1, 'x'};
  proto::ApprovalReq r;
  CHECK(proto::parseApprovalReq(req, sizeof req, r) && r.id == 263, "an approval id above 255");
  std::vector<uint8_t> long300 = {2, 2, 0x2C, 0x01};  // TEXT, 300 bytes
  long300.insert(long300.end(), 300, 'a');
  proto::UiView v;
  CHECK(proto::parseUi(long300.data(), long300.size(), v) && v.text.n == 300, "a field of 300 bytes");
  proto::TestOp t = {0, nullptr, 0};
  CHECK(!proto::parseTest(zero, 0, t), "an empty TEST frame names no operation");
}
