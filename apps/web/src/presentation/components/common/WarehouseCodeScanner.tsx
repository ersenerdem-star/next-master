import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { translateAppText, type AppLanguage } from "../../../shared/i18n";

type WarehouseCodeScannerProps = {
  language?: AppLanguage;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  helperText?: string;
  submitLabel?: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
};

type BrowserWindowWithBarcodeDetector = Window & {
  BarcodeDetector?: new (options?: { formats?: string[] }) => {
    detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
  };
};

type ScannerControls = {
  stop: () => void;
};

type ScannerReader = {
  decodeFromVideoDevice: (
    deviceId: string | undefined,
    previewElem: HTMLVideoElement | undefined,
    callbackFn: (result: { getText?: () => string } | undefined, error: unknown, controls: ScannerControls) => void,
  ) => Promise<ScannerControls>;
  reset?: () => void;
};

const BARCODE_FORMATS = [
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "ean_13",
  "ean_8",
  "itf",
  "qr_code",
  "upc_a",
  "upc_e",
];

export function WarehouseCodeScanner({
  language = "en",
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  helperText,
  submitLabel,
  busy = false,
  busyLabel,
  disabled = false,
}: WarehouseCodeScannerProps) {
  const resolvedLabel = label || translateAppText(language, "scanner.label");
  const resolvedPlaceholder = placeholder || translateAppText(language, "scanner.placeholder");
  const resolvedHelperText = helperText || translateAppText(language, "scanner.helper");
  const resolvedSubmitLabel = submitLabel || translateAppText(language, "scanner.find");
  const helperMessageRef = useRef(resolvedHelperText);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopRef = useRef<number | null>(null);
  const fallbackControlsRef = useRef<ScannerControls | null>(null);
  const fallbackReaderRef = useRef<ScannerReader | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraMessage, setCameraMessage] = useState(resolvedHelperText);

  const cameraApiSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const nativeBarcodeSupported =
    typeof window !== "undefined" &&
    Boolean((window as BrowserWindowWithBarcodeDetector).BarcodeDetector);

  function stopCamera() {
    if (scanLoopRef.current) {
      window.clearTimeout(scanLoopRef.current);
      scanLoopRef.current = null;
    }
    if (fallbackControlsRef.current) {
      fallbackControlsRef.current.stop();
      fallbackControlsRef.current = null;
    }
    if (fallbackReaderRef.current?.reset) {
      fallbackReaderRef.current.reset();
    }
    fallbackReaderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setCameraBusy(false);
    setCameraOpen(false);
  }

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  useEffect(() => {
    if (cameraMessage === helperMessageRef.current) {
      setCameraMessage(resolvedHelperText);
    }
    helperMessageRef.current = resolvedHelperText;
  }, [cameraMessage, resolvedHelperText]);

  async function waitForVideoElement() {
    return new Promise<HTMLVideoElement>((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (videoRef.current) {
          resolve(videoRef.current);
          return;
        }
        if (Date.now() - startedAt > 2000) {
          reject(new Error(translateAppText(language, "scanner.camera_prepare_failed")));
          return;
        }
        window.requestAnimationFrame(poll);
      };
      poll();
    });
  }

  async function runDetectorLoop() {
    const video = videoRef.current;
    const BarcodeDetectorCtor = (window as BrowserWindowWithBarcodeDetector).BarcodeDetector;
    if (!video || !BarcodeDetectorCtor) return;

    try {
      const detector = new BarcodeDetectorCtor({ formats: BARCODE_FORMATS });
      const results = await detector.detect(video);
      const match = results.find((item) => String(item.rawValue || "").trim());
      if (match?.rawValue) {
        const detectedValue = String(match.rawValue || "").trim();
        onChange(detectedValue);
        onSubmit(detectedValue);
        setCameraMessage(translateAppText(language, "scanner.scanned", { value: detectedValue }));
        stopCamera();
        return;
      }
    } catch {
      setCameraMessage(translateAppText(language, "scanner.camera_detection_wait"));
      stopCamera();
      return;
    }

    scanLoopRef.current = window.setTimeout(() => {
      void runDetectorLoop();
    }, 450);
  }

  async function handleStartCamera() {
    if (!cameraApiSupported) {
      setCameraMessage(translateAppText(language, "scanner.camera_not_supported"));
      return;
    }

    try {
      setCameraBusy(true);
      setCameraMessage(translateAppText(language, "scanner.camera_opening"));
      if (nativeBarcodeSupported) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
          },
          audio: false,
        });
        streamRef.current = stream;
        setCameraOpen(true);
        const preview = await waitForVideoElement();
        preview.srcObject = stream;
        await preview.play();
        setCameraBusy(false);
        setCameraMessage(translateAppText(language, "scanner.camera_point"));
        await runDetectorLoop();
        return;
      }

      const [{ BrowserMultiFormatReader }] = await Promise.all([import("@zxing/browser")]);
      setCameraOpen(true);
      const preview = await waitForVideoElement();
      const reader = new BrowserMultiFormatReader();
      fallbackReaderRef.current = reader as ScannerReader;
      const controls = await reader.decodeFromVideoDevice(undefined, preview, (result, error, activeControls) => {
        const detectedValue = String(result?.getText?.() || "").trim();
        if (detectedValue) {
          fallbackControlsRef.current = activeControls;
          onChange(detectedValue);
          onSubmit(detectedValue);
          setCameraMessage(translateAppText(language, "scanner.scanned", { value: detectedValue }));
          stopCamera();
          return;
        }
        if (error && String((error as { name?: string }).name || "") !== "NotFoundException") {
          setCameraMessage(translateAppText(language, "scanner.camera_decode_wait"));
        }
      });
      fallbackControlsRef.current = controls as ScannerControls;
      setCameraBusy(false);
      setCameraMessage(translateAppText(language, "scanner.camera_point"));
    } catch {
      stopCamera();
      setCameraBusy(false);
      setCameraOpen(false);
      setCameraMessage(translateAppText(language, "scanner.camera_permission_denied"));
    }
  }

  return (
    <div className="warehouse-scanner">
      <div className="warehouse-scanner__controls">
        <Input
          label={resolvedLabel}
          value={value}
          onChange={onChange}
          onEnter={() => onSubmit(value)}
          placeholder={resolvedPlaceholder}
          disabled={disabled}
        />
        <div className="warehouse-scanner__actions">
          <Button onClick={() => onSubmit(value)} busy={busy} busyLabel={busyLabel} disabled={disabled}>
            {resolvedSubmitLabel}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleStartCamera()}
            busy={cameraBusy}
            busyLabel={translateAppText(language, "scanner.opening")}
            disabled={disabled}
          >
            {translateAppText(language, "scanner.use_camera")}
          </Button>
          {cameraOpen ? (
            <Button variant="secondary" onClick={stopCamera}>
              {translateAppText(language, "scanner.stop_camera")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="warehouse-scanner__helper">{cameraMessage}</div>
      {cameraOpen ? (
        <div className="warehouse-scanner__preview">
          <video ref={videoRef} className="warehouse-scanner__video" autoPlay muted playsInline />
        </div>
      ) : null}
    </div>
  );
}
