const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const REDIS_URL = "rediss://default:gQAAAAAAAYUYAAIgcDFmN2EzMWVjZmQyZGE0NDI4OWIzNmRjNjlkNjZhYmIzYQ@shining-dog-99608.upstash.io:6379";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const queue = new Queue("akchat-send", { connection });

(async () => {
  const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  console.log("Job counts:", counts);

  const waiting = await queue.getWaiting(0, 10);
  console.log("Waiting jobs:", waiting.map(j => ({ id: j.id, kind: j.data?.kind, to: j.data?.to, timestamp: j.timestamp })));

  const failed = await queue.getFailed(0, 10);
  console.log("Failed jobs:", failed.map(j => ({ id: j.id, kind: j.data?.kind, to: j.data?.to, failedReason: j.failedReason })));

  await connection.quit();
})();
