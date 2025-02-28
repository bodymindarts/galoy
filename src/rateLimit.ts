const { RateLimiterRedis } = require('rate-limiter-flexible');
import { yamlConfig } from "./config";
import { redis } from './redis'

export const limiterRequestPhoneCode = new RateLimiterRedis({
  redis,
  keyPrefix: 'request_phone_code',
  points: yamlConfig.limits.requestPhoneCode.points,
  duration: yamlConfig.limits.requestPhoneCode.duration,
  blockDuration: yamlConfig.limits.requestPhoneCode.blockDuration, 
});

export const limiterLoginAttempt = new RateLimiterRedis({
  redis,
  keyPrefix: 'login',
  points: yamlConfig.limits.loginAttempt.points,
  duration: yamlConfig.limits.loginAttempt.duration,
  blockDuration: yamlConfig.limits.loginAttempt.blockDuration, 
});

// TODO:
// add fibonachi on failed login
// https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#dynamic-block-duration

export const failedAttemptPerIp = new RateLimiterRedis({
  redis,
  keyPrefix: 'failed_attempt_ip',
  points: yamlConfig.limits.failedAttemptPerIp.points,
  duration: yamlConfig.limits.failedAttemptPerIp.duration,
  blockDuration: yamlConfig.limits.failedAttemptPerIp.blockDuration, 
});
