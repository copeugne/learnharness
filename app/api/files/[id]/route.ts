import { downloadLearnerFile, deleteLearnerFile } from '@/src/server';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  if (!process.env.LH_WEB_RUNTIME_SECRET) return Response.json({ error: 'Not found.' }, { status: 404 });
  return downloadLearnerFile((await context.params).id);
}
export async function DELETE(_request: Request, context: Context) {
  if (!process.env.LH_WEB_RUNTIME_SECRET) return Response.json({ error: 'Not found.' }, { status: 404 });
  return deleteLearnerFile((await context.params).id);
}
