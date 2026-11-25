// One Redis operation so concurrent serverless invocations cannot write
// between comparing the current version and saving the replacement.
const script = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export async function compareAndSet(redis, key, previous, next) {
  return (await redis.eval(script, 1, key, previous || "", next)) === 1;
}
