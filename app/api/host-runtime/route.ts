import { activityFeed, activeCompactionCount, runningTurnCount } from '@/src/server';

export const dynamic = 'force-dynamic';

/** The account gateway hides this route from learners. Its direct runtime
 * request must carry the same per-container capability as every other route. */
export function GET() {
  const activity = activityFeed();
  const idle = runningTurnCount() === 0 && activeCompactionCount() === 0 && activity.jobs.length === 0 && activity.extractions.length === 0;
  return Response.json({ idle }, { headers: { 'Cache-Control': 'no-store' } });
}
