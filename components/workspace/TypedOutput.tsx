'use client';

// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { useMemo } from 'react';
import { classifyStdout, artifactsFromOutput, type StdoutChunk } from '@/lib/workspace/stdout-types';

/**
 * Process output, rendered as the thing it is.
 *
 * A terminal shows every result as the same grey text, so a table, a saved
 * render, and a stack trace are equally hard to act on — you read the line,
 * then go find the file yourself. Classification is what makes the difference
 * mechanical instead of manual.
 *
 * The typed view never replaces the log: `chunk.raw` is preserved on every
 * chunk, and `text` remains the answer whenever the classifier is not certain.
 * A wrong guess here is worse than no guess, because it makes output look like
 * a fact the system checked when it is only a shape it recognised.
 */

type TypedOutputProps = {
  value: string;
  stream?: 'stdout' | 'stderr';
  /** Handed the raw output so the host builds seeds through `seedsFromRunOutput`. */
  onPlace?: (output: string) => void;
};

const LINK = /(https?:\/\/[^\s)]+)(?=[\s)]|$)/g;

function Linked({ value }: { value: string }) {
  return (
    <>
      {value.split(LINK).map((part, index) => /^https?:\/\//i.test(part)
        ? <a href={part} target="_blank" rel="noreferrer" key={`${part}:${index}`}>{part}</a>
        : <span key={`${part}:${index}`}>{part}</span>)}
    </>
  );
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return (
    <div className="hii-output-table">
      <table>
        <thead><tr>{head.map((cell, index) => <th key={`${cell}:${index}`}>{cell}</th>)}</tr></thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={`${cell}:${index}`}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TypedOutput({ value, stream = 'stdout', onPlace }: TypedOutputProps) {
  const chunk = useMemo(() => classifyStdout(value, stream), [value, stream]);
  // Artifacts are found across the whole output, not just when the output is
  // *only* a path — a script that prints progress and then saves three files
  // is the ordinary case.
  const artifacts = useMemo(() => artifactsFromOutput(value), [value]);

  return (
    <div className="hii-output" data-type={chunk.type}>
      {chunk.type === 'table' && Array.isArray(chunk.value)
        ? <Table rows={chunk.value as string[][]} />
        : chunk.type === 'json'
          ? <pre className="hii-output-json">{JSON.stringify(chunk.value, null, 2)}</pre>
          : (
            <div className="hii-output-text">
              {chunk.raw.split('\n').map((line, index) => (
                <span key={`${line}:${index}`}><Linked value={line} /></span>
              ))}
            </div>
          )}

      {artifacts.length > 0 && (
        <div className="hii-output-artifacts">
          <span className="hii-output-artifacts-label">
            {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'} produced
          </span>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.path} data-kind={artifact.type}>
                <code>{artifact.path}</code>
                <span>{artifact.type}</span>
              </li>
            ))}
          </ul>
          {onPlace && (
            // Placing is a canvas mutation, so it stays a decision the person
            // makes rather than something the run does on its way out.
            <button type="button" onClick={() => onPlace(value)}>
              Place on canvas
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export type { StdoutChunk };
