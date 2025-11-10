import React, { useState, useRef } from "react";

function App() {
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunks = useRef([]);

  const startRecording = async () => {
    try {
      // Capture screen video
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // some browsers support system audio capture
      });

      // Capture microphone audio separately
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Combine both screen and mic audio
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);

      mediaRecorderRef.current = new MediaRecorder(combinedStream, {
        mimeType: "video/webm; codecs=vp9",
      });

      chunks.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(chunks.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        setVideoUrl(url);

        // Stop all media tracks to free resources
        screenStream.getTracks().forEach((track) => track.stop());
        audioStream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorderRef.current.start();
      setRecording(true);
    } catch (error) {
      console.error("Error starting recording:", error);
      alert("Unable to start recording. Please allow permissions.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: "50px" }}>
      <h1>🎥 Screen + Audio Recorder</h1>

      {!recording ? (
        <button onClick={startRecording}>Start Recording</button>
      ) : (
        <button onClick={stopRecording}>Stop Recording</button>
      )}

      {videoUrl && (
        <div style={{ marginTop: "20px" }}>
          <h3>Preview:</h3>
          <video src={videoUrl} controls style={{ width: "80%" }} />
          <br />
          <a href={videoUrl} download="recording.webm">
            Download Recording
          </a>
        </div>
      )}
    </div>
  );
}

export default App;
