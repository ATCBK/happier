#pragma once

#include <sherpa-onnx/c-api/c-api.h>
#include <limits>
#include <vector>
#include "HappierSherpaCapiAbi.h"

namespace happier_sherpa {

inline SherpaOnnxOnlineRecognizerConfig OnlineTransducerConfig(
    const char *tokens, const char *encoder, const char *decoder, const char *joiner) {
  SherpaOnnxOnlineRecognizerConfig config{};
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.tokens = tokens;
  config.model_config.num_threads = 2;
  config.model_config.provider = "cpu";
  config.model_config.model_type = "";
  config.model_config.transducer.encoder = encoder;
  config.model_config.transducer.decoder = decoder;
  config.model_config.transducer.joiner = joiner;
  config.decoding_method = "greedy_search";
  config.max_active_paths = 4;
  config.enable_endpoint = 1;
  config.rule1_min_trailing_silence = 1.2f;
  config.rule2_min_trailing_silence = 0.6f;
  // Rule 3 fires on duration alone, including uninterrupted speech. Only trailing
  // silence may end a voice turn; zero would restore Sherpa's duration default.
  config.rule3_min_utterance_length = std::numeric_limits<float>::max();
  return config;
}

template <typename IsCancelled>
bool FinishOnlineTransducer(const SherpaOnnxOnlineRecognizer *recognizer,
                            const SherpaOnnxOnlineStream *stream,
                            IsCancelled isCancelled,
                            int32_t inputSampleRate = 16000) {
  if (isCancelled()) return false;
  // Native v1.12.25's supported streaming-transducer recipe: 0.3 seconds
  // at the stream's input rate, then input-finished and readiness drain. Keep
  // that rate unchanged: sherpa's existing resampler rejects a rate switch.
  // https://github.com/k2-fsa/sherpa-onnx/blob/v1.12.25/c-api-examples/decode-file-c-api.c
  const std::vector<float> tail(static_cast<size_t>(inputSampleRate) * 3 / 10, 0.0f);
  SherpaOnnxOnlineStreamAcceptWaveform(stream, inputSampleRate, tail.data(), static_cast<int32_t>(tail.size()));
  if (isCancelled()) return false;
  SherpaOnnxOnlineStreamInputFinished(stream);
  while (!isCancelled() && SherpaOnnxIsOnlineStreamReady(recognizer, stream)) {
    SherpaOnnxDecodeOnlineStream(recognizer, stream);
  }
  return !isCancelled();
}

}  // namespace happier_sherpa
