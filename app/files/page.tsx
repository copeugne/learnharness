import { LearnerFiles } from '@/components/learner-files';
import { notFound } from 'next/navigation';
export default function FilesPage() {
  if (process.env.LH_WEB_HOSTED !== '1') notFound();
  return <LearnerFiles />;
}
