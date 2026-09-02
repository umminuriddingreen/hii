// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { Microphone, Stop } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
};

type SpeechRecognitionErrorEventLike = Event & { error?: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor() {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function VoiceInputButton({ onTranscript, disabled = false, className = '' }: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSupported(Boolean(recognitionConstructor()));
    return () => recognition.current?.abort();
  }, []);

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setError('Voice input is not available in this browser.');
      return;
    }
    const next = new Recognition();
    recognition.current = next;
    next.continuous = false;
    next.interimResults = true;
    next.lang = navigator.language || 'en-US';
    next.onresult = (event) => {
      const transcript = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript || '')
        .join(' ')
        .trim();
      if (transcript) onTranscript(transcript);
    };
    next.onerror = (event) => {
      setError(event.error === 'not-allowed' ? 'Microphone permission is required for voice input.' : 'Voice input stopped. Try again.');
      setListening(false);
    };
    next.onend = () => setListening(false);
    setError('');
    setListening(true);
    try { next.start(); } catch { setListening(false); }
  };

  return <>
    <button
      type="button"
      className={className}
      aria-label={listening ? 'Stop voice input' : supported ? 'Start voice input' : 'Voice input unavailable'}
      aria-pressed={listening}
      disabled={disabled || !supported}
      title={supported ? (listening ? 'Stop listening' : 'Speak to HII using browser speech recognition') : 'Voice input is unavailable in this browser'}
      onClick={toggle}
    >
      {listening ? <Stop size={17} weight="fill" /> : <Microphone size={18} weight="regular" />}
    </button>
    {error ? <span className="hii-voice-input-error" role="status">{error}</span> : null}
  </>;
}
