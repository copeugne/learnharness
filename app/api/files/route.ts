import { learnerFilesResponse, uploadLearnerFiles } from '@/src/server';
export const dynamic = 'force-dynamic';
export function GET() {
  if (!process.env.LH_WEB_RUNTIME_SECRET) return Response.json({ error: 'Not found.' }, { status: 404 });
  return learnerFilesResponse();
}
export function POST(request: Request) {
  if (!process.env.LH_WEB_RUNTIME_SECRET) return Response.json({ error: 'Not found.' }, { status: 404 });
  return uploadLearnerFiles(request);
}
