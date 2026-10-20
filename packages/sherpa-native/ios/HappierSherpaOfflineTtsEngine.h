#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HappierSherpaOfflineTtsEngine : NSObject

- (nullable instancetype)initWithAssetsDir:(NSString *)assetsDir error:(NSError **)error;

- (int32_t)sampleRate;
- (int32_t)numSpeakers;

- (BOOL)synthesizeToWavFileAtPath:(NSString *)wavPath
                             text:(NSString *)text
                              sid:(int32_t)sid
                            speed:(float)speed
                            jobId:(NSString *)jobId
                            error:(NSError **)error;

/// Cancels a running synthesis, or the next one started with this job id if it has not begun yet.
+ (void)cancelJob:(NSString *)jobId;

@end

NS_ASSUME_NONNULL_END
