import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE = `export async function TOOL_NAME(args: any): Promise<string> {
  // TODO: implement tool logic
  return JSON.stringify({ ok: true, args });
}
`;

export function scaffoldTool(name: string): string {
  const dir = path.resolve(process.cwd(), 'src', 'tools');
  const file = path.join(dir, `${name}.ts`);
  if (fs.existsSync(file)) throw new Error('Tool already exists');
  const content = TEMPLATE.replace('TOOL_NAME', name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

