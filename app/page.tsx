// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { HiiWebAccess } from '@/components/auth/HiiWebAccess';

export default async function Home() {
  if (process.env.NEXT_PUBLIC_HII_TARGET === 'desktop') {
    const { HiiRoot } = await import('@/components/workspace/HiiRoot');
    return <HiiRoot />;
  }
  return <HiiWebAccess />;
}
