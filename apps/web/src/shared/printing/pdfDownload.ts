type DownloadPdfFromHtmlInput = {
  filename: string;
  html: string;
  format?: "a4" | [number, number];
  orientation?: "portrait" | "landscape";
  pagebreak?: {
    after?: string | string[];
    before?: string | string[];
    avoid?: string | string[];
    mode?: Array<"avoid-all" | "css" | "legacy">;
  };
};

function waitForFrameLoad(frame: HTMLIFrameElement) {
  return new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve();
    frame.onerror = () => reject(new Error("PDF template failed to load."));
  });
}

function waitForFramePaint(frameWindow: Window) {
  return new Promise<void>((resolve) => {
    frameWindow.requestAnimationFrame(() => {
      frameWindow.requestAnimationFrame(() => resolve());
    });
  });
}

export async function downloadPdfFromHtml(input: DownloadPdfFromHtmlInput) {
  const { default: html2pdf } = await import("html2pdf.js");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "-200vw";
  frame.style.bottom = "0";
  frame.style.width = "1200px";
  frame.style.height = "1600px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.border = "0";
  document.body.appendChild(frame);

  try {
    const loaded = waitForFrameLoad(frame);
    frame.srcdoc = input.html;
    await loaded;

    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument;
    if (!frameWindow || !frameDocument?.body) {
      throw new Error("PDF preview frame unavailable.");
    }

    const fontSet = (frameDocument as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fontSet?.ready) {
      await Promise.race([
        fontSet.ready.then(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    }

    await waitForFramePaint(frameWindow);

    const worker = html2pdf() as {
      set(options: Record<string, unknown>): {
        from(source: HTMLElement): {
          save(): Promise<void>;
        };
      };
    };

    await worker
      .set({
        margin: 0,
        filename: input.filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: Math.min(window.devicePixelRatio || 2, 2),
          useCORS: true,
          backgroundColor: "#ffffff",
          windowWidth: Math.max(
            frameDocument.documentElement.scrollWidth,
            frameDocument.body.scrollWidth,
            1200,
          ),
          scrollX: 0,
          scrollY: 0,
        },
        jsPDF: {
          unit: "mm",
          format: input.format || "a4",
          orientation: input.orientation || "portrait",
          compress: true,
        },
        pagebreak: input.pagebreak || { mode: ["css", "legacy"], avoid: ["tr", "table", ".avoid-page-break"] },
      })
      .from(frameDocument.body)
      .save();
  } finally {
    frame.remove();
  }
}
