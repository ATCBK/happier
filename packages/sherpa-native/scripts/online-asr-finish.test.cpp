#include <algorithm>
#include <cassert>
#include <limits>
#include <vector>

#include "HappierSherpaOnlineAsr.h"

// sherpa is the genuine external inference boundary. Keep our complete finish
// routine real, and model a chunk that is ready only after acoustic tail input.
struct SherpaOnnxOnlineStream {
  mutable std::vector<float> tail;
  mutable bool inputFinished = false;
  mutable bool decoded = false;
  int32_t inputSampleRate = 16000;
};
struct SherpaOnnxOnlineRecognizer {};

void SherpaOnnxOnlineStreamAcceptWaveform(const SherpaOnnxOnlineStream *stream,
                                        int32_t sampleRate, const float *samples, int32_t count) {
  assert(sampleRate == stream->inputSampleRate);
  assert(!stream->inputFinished);
  stream->tail.insert(stream->tail.end(), samples, samples + count);
}
void SherpaOnnxOnlineStreamInputFinished(const SherpaOnnxOnlineStream *stream) {
  stream->inputFinished = true;
}
int32_t SherpaOnnxIsOnlineStreamReady(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  return stream->inputFinished && stream->tail.size() >= static_cast<size_t>(stream->inputSampleRate) * 3 / 10 && !stream->decoded;
}
void SherpaOnnxDecodeOnlineStream(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  stream->decoded = true;
}

int main() {
  const auto config = happier_sherpa::OnlineTransducerConfig("tokens", "encoder", "decoder", "joiner");
  assert(config.feat_config.sample_rate == 16000);
  assert(config.max_active_paths == 4 && config.enable_endpoint == 1);
  assert(config.model_config.transducer.encoder != nullptr);
  assert(config.model_config.tokens != nullptr && config.model_config.provider != nullptr);
  assert(config.rule1_min_trailing_silence == 1.2f && config.rule2_min_trailing_silence == 0.6f);
  assert(config.rule3_min_utterance_length == std::numeric_limits<float>::max());

  SherpaOnnxOnlineRecognizer recognizer;
  SherpaOnnxOnlineStream stream;
  assert(happier_sherpa::FinishOnlineTransducer(&recognizer, &stream, [] { return false; }));
  assert(stream.decoded);
  assert(stream.tail.size() == 4800);
  assert(std::all_of(stream.tail.begin(), stream.tail.end(), [](float sample) { return sample == 0; }));

  SherpaOnnxOnlineStream cancelled;
  assert(!happier_sherpa::FinishOnlineTransducer(&recognizer, &cancelled, [] { return true; }));
  assert(cancelled.tail.empty() && !cancelled.inputFinished && !cancelled.decoded);

  SherpaOnnxOnlineStream cancelledDuringDecode;
  assert(!happier_sherpa::FinishOnlineTransducer(&recognizer, &cancelledDuringDecode,
      [&] { return cancelledDuringDecode.decoded; }));
  assert(cancelledDuringDecode.decoded);

  SherpaOnnxOnlineStream resampled;
  resampled.inputSampleRate = 48000;
  assert(happier_sherpa::FinishOnlineTransducer(&recognizer, &resampled, [] { return false; }, 48000));
  assert(resampled.decoded && resampled.tail.size() == 14400);
}
