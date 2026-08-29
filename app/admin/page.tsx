import { notFound } from 'next/navigation';
import { HiiAdmin } from '@/components/admin/HiiAdmin';

export const metadata = { title: 'HII / Local administration' };

export default function AdminPage() {
  if (process.env.NEXT_PUBLIC_HII_TARGET !== 'desktop') notFound();
  return <HiiAdmin />;
}
