#!/usr/bin/env swift
import AVFoundation
import Foundation
import Speech

func jsonEscape(_ value: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [value], options: [])
  let encoded = String(data: data, encoding: .utf8) ?? "[\"\"]"
  return String(encoded.dropFirst().dropLast())
}

func emit(_ fields: [String: String]) {
  let body = fields
    .map { "\"\($0.key)\":\(jsonEscape($0.value))" }
    .sorted()
    .joined(separator: ",")
  print("{\(body)}")
  fflush(stdout)
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
guard let recognizer else {
  emit(["type": "error", "message": "speech recognizer unavailable"])
  exit(2)
}

let authGroup = DispatchGroup()
var speechStatus = SFSpeechRecognizerAuthorizationStatus.notDetermined
authGroup.enter()
SFSpeechRecognizer.requestAuthorization { status in
  speechStatus = status
  authGroup.leave()
}
authGroup.wait()

guard speechStatus == .authorized else {
  emit(["type": "error", "message": "speech recognition permission is \(speechStatus.rawValue)"])
  exit(3)
}

if #available(macOS 10.14, *) {
  let micGroup = DispatchGroup()
  var micGranted = false
  micGroup.enter()
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    micGranted = granted
    micGroup.leave()
  }
  micGroup.wait()
  guard micGranted else {
    emit(["type": "error", "message": "microphone permission denied"])
    exit(4)
  }
}

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if #available(macOS 13.0, *) {
  request.addsPunctuation = true
}

let inputNode = audioEngine.inputNode
let format = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
}

let task = recognizer.recognitionTask(with: request) { result, error in
  if let result {
    emit([
      "type": result.isFinal ? "final" : "partial",
      "text": result.bestTranscription.formattedString
    ])
  }
  if let error {
    emit(["type": "error", "message": error.localizedDescription])
  }
}

do {
  audioEngine.prepare()
  try audioEngine.start()
  emit(["type": "ready", "message": "listening"])
  RunLoop.main.run()
} catch {
  task.cancel()
  emit(["type": "error", "message": error.localizedDescription])
  exit(5)
}
