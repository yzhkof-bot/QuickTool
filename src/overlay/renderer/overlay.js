/* global document, window, Image, requestAnimationFrame, quickCapture */
(() => {
  const canvas = document.getElementById('overlay-canvas');
  const ctx = canvas.getContext('2d');
  const sizeLabel = document.getElementById('size-label');
  const toolbar = document.getElementById('annotation-toolbar');
  const textInput = document.getElementById('text-input');

  let screenshot = null;
  let monitorId = 0;
  let scaleFactor = 1;
  let mode = 'screenshot';

  let selecting = false;
  let selectionDone = false;
  let startX = 0;
  let startY = 0;
  let endX = 0;
  let endY = 0;

  let annotationMode = 'none';
  let currentColor = '#ff0000';
  const annotations = [];
  let drawingArrow = false;
  let arrowStart = { x: 0, y: 0 };
  let arrowEnd = { x: 0, y: 0 };

  let mouseX = 0;
  let mouseY = 0;

  function initCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getSelection() {
    return {
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      width: Math.abs(endX - startX),
      height: Math.abs(endY - startY),
    };
  }

  function drawArrow(from, to, color, strokeWidth) {
    const headLength = 15;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
      to.x - headLength * Math.cos(angle - Math.PI / 6),
      to.y - headLength * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      to.x - headLength * Math.cos(angle + Math.PI / 6),
      to.y - headLength * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  function drawTextAnnotation(annotation) {
    ctx.fillStyle = annotation.color;
    ctx.font = `${annotation.fontSize}px Arial, Helvetica, sans-serif`;
    ctx.fillText(annotation.content, annotation.position.x, annotation.position.y + annotation.fontSize);
  }

  function render() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    ctx.clearRect(0, 0, width, height);
    if (screenshot) ctx.drawImage(screenshot, 0, 0, width, height);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, width, height);

    if (selecting || selectionDone) {
      const selection = getSelection();
      if (selection.width > 0 && selection.height > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(selection.x, selection.y, selection.width, selection.height);
        ctx.clip();
        if (screenshot) ctx.drawImage(screenshot, 0, 0, width, height);
        ctx.restore();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width - 1, selection.height - 1);
        ctx.setLineDash([]);

        sizeLabel.textContent = `${Math.round(selection.width * scaleFactor)} x ${Math.round(selection.height * scaleFactor)}`;
        sizeLabel.style.display = 'block';
        sizeLabel.style.left = `${selection.x}px`;
        sizeLabel.style.top = `${Math.max(0, selection.y - 24)}px`;
      }
    } else {
      sizeLabel.style.display = 'none';
    }

    if (!selectionDone) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, mouseY);
      ctx.lineTo(width, mouseY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mouseX, 0);
      ctx.lineTo(mouseX, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const annotation of annotations) {
      if (annotation.type === 'arrow') drawArrow(annotation.from, annotation.to, annotation.color, annotation.strokeWidth);
      if (annotation.type === 'text') drawTextAnnotation(annotation);
    }
    if (drawingArrow) drawArrow(arrowStart, arrowEnd, currentColor, 3);

    requestAnimationFrame(render);
  }

  function showToolbar() {
    const selection = getSelection();
    toolbar.style.display = 'flex';
    toolbar.style.left = `${selection.x}px`;
    toolbar.style.top = `${selection.y + selection.height + 8}px`;
    document.body.style.cursor = 'default';
  }

  function scaleAnnotation(annotation, selection) {
    if (annotation.type === 'arrow') {
      return {
        ...annotation,
        from: {
          x: Math.round((annotation.from.x - selection.x) * scaleFactor),
          y: Math.round((annotation.from.y - selection.y) * scaleFactor),
        },
        to: {
          x: Math.round((annotation.to.x - selection.x) * scaleFactor),
          y: Math.round((annotation.to.y - selection.y) * scaleFactor),
        },
      };
    }

    return {
      ...annotation,
      position: {
        x: Math.round((annotation.position.x - selection.x) * scaleFactor),
        y: Math.round((annotation.position.y - selection.y) * scaleFactor),
      },
      fontSize: Math.round(annotation.fontSize * scaleFactor),
    };
  }

  function confirmCapture() {
    const selection = getSelection();
    quickCapture.sendSelectionDone({
      region: {
        x: Math.round(selection.x * scaleFactor),
        y: Math.round(selection.y * scaleFactor),
        width: Math.round(selection.width * scaleFactor),
        height: Math.round(selection.height * scaleFactor),
      },
      monitorId,
      annotations: annotations.map((annotation) => scaleAnnotation(annotation, selection)),
      mode,
    });
  }

  canvas.addEventListener('mousedown', (event) => {
    if (selectionDone) {
      if (annotationMode === 'arrow') {
        drawingArrow = true;
        arrowStart = { x: event.clientX, y: event.clientY };
        arrowEnd = { x: event.clientX, y: event.clientY };
      } else if (annotationMode === 'text') {
        textInput.style.display = 'block';
        textInput.style.left = `${event.clientX}px`;
        textInput.style.top = `${event.clientY}px`;
        textInput.style.color = currentColor;
        textInput.value = '';
        textInput.focus();
      }
      return;
    }

    selecting = true;
    startX = event.clientX;
    startY = event.clientY;
    endX = event.clientX;
    endY = event.clientY;
  });

  canvas.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (selecting) {
      endX = event.clientX;
      endY = event.clientY;
    }
    if (drawingArrow) arrowEnd = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener('mouseup', (event) => {
    if (drawingArrow) {
      drawingArrow = false;
      arrowEnd = { x: event.clientX, y: event.clientY };
      if (Math.abs(arrowEnd.x - arrowStart.x) > 5 || Math.abs(arrowEnd.y - arrowStart.y) > 5) {
        annotations.push({
          type: 'arrow',
          from: arrowStart,
          to: arrowEnd,
          color: currentColor,
          strokeWidth: 3,
        });
      }
      return;
    }

    if (!selecting) return;
    selecting = false;
    endX = event.clientX;
    endY = event.clientY;

    const selection = getSelection();
    if (selection.width < 5 || selection.height < 5) {
      selectionDone = false;
      return;
    }

    selectionDone = true;
    if (mode === 'gif') confirmCapture();
    else showToolbar();
  });

  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const text = textInput.value.trim();
      if (text) {
        annotations.push({
          type: 'text',
          position: {
            x: parseInt(textInput.style.left, 10),
            y: parseInt(textInput.style.top, 10),
          },
          content: text,
          color: currentColor,
          fontSize: 16,
        });
      }
      textInput.style.display = 'none';
      textInput.value = '';
    }
    if (event.key === 'Escape') {
      textInput.style.display = 'none';
      textInput.value = '';
    }
  });

  document.getElementById('btn-arrow').addEventListener('click', () => {
    annotationMode = 'arrow';
    document.getElementById('btn-arrow').classList.add('active');
    document.getElementById('btn-text').classList.remove('active');
    document.body.style.cursor = 'crosshair';
  });

  document.getElementById('btn-text').addEventListener('click', () => {
    annotationMode = 'text';
    document.getElementById('btn-text').classList.add('active');
    document.getElementById('btn-arrow').classList.remove('active');
    document.body.style.cursor = 'text';
  });

  document.getElementById('color-red').addEventListener('click', () => { currentColor = '#ff0000'; });
  document.getElementById('color-yellow').addEventListener('click', () => { currentColor = '#ffff00'; });
  document.getElementById('color-green').addEventListener('click', () => { currentColor = '#00ff00'; });
  document.getElementById('btn-confirm').addEventListener('click', confirmCapture);
  document.getElementById('btn-cancel').addEventListener('click', () => quickCapture.sendSelectionCancel());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') quickCapture.sendSelectionCancel();
  });

  quickCapture.onScreenshotData((data) => {
    monitorId = data.monitorId;
    scaleFactor = data.scaleFactor;
    mode = data.mode;

    const image = new Image();
    image.onload = () => {
      screenshot = image;
    };
    image.src = data.screenshotDataUrl;
  });

  initCanvas();
  render();
  window.addEventListener('resize', initCanvas);
})();
