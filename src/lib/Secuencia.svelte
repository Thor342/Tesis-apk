<script lang="ts">
    import * as XLSX from "xlsx";
    import { supabase } from './supabaseClient';
    import { tick } from 'svelte';
    import { Capacitor } from '@capacitor/core';
    import { Filesystem, Directory } from '@capacitor/filesystem';
    import { Share } from '@capacitor/share';

    const SvgChulito = `<svg viewBox="0 0 100 100" class="icon-chulo"><path d="M20 50 L45 75 L80 25" fill="none" stroke="#4ade80" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const SvgEquis   = `<svg viewBox="0 0 100 100" class="icon-equis"><path d="M25 25 L75 75 M75 25 L25 75" fill="none" stroke="#f87171" stroke-width="12" stroke-linecap="round"/></svg>`;

    // Color único por nodo (mostrado durante la fase memo)
    const NODE_COLORS = [
        '#6366f1', '#ec4899', '#f59e0b', '#10b981',
        '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6',
        '#f97316', '#84cc16', '#06b6d4', '#a855f7',
    ];

    let {
        onVolver      = undefined as (() => void) | undefined,
        onTerminar    = undefined as (() => void) | undefined,
        evaluacion_id = undefined as number | undefined,
        modoEvaluacion = false as boolean
    } = $props();

    // ── Estado de guardado ────────────────────────────────────────────────────
    let guardandoResultados = $state(false);
    let errorGuardado       = $state<string | null>(null);
    let resultadoGuardado   = $state(false);

    const NODES = Array.from({ length: 12 }, (_, i) => ({ id: i }));

    // Los primeros 5 intentos son práctica (excluidos de métricas).
    // Secuencia fija de longitud 3 para familiarizar sin frustración.
    const PRACTICE_TOTAL   = 5;
    const PRACTICE_SEQ_LEN = 3;

    let phase         = $state<'inicio' | 'memo' | 'test' | 'reporte' | 'pausado' | 'practica-completada'>('inicio');
    let sessionId     = $state(0);
    let feedback      = $state<'none' | 'success' | 'error'>('none');
    let sequence      = $state<number[]>([]);
    let userSequence  = $state<number[]>([]);
    let activeId      = $state<number | null>(null);
    let level         = $state(1);
    let totalErrors   = $state(0);
    let inPractice    = $state(false);
    let practiceCount = $state(0);
    let isPractice    = $derived(inPractice);

    // ── Métricas científicas ──────────────────────────────────────────────────
    // frl = First Response Latency: tiempo desde que la pantalla test se pinta
    //       hasta el PRIMER clic de cada nivel. Mide inicio de recuperación.
    // iri = Inter-Response Interval: tiempo entre clics consecutivos dentro
    //       de una misma secuencia. Mide velocidad de ejecución.
    let frlList       = $state<number[]>([]);   // una entrada por nivel jugado
    let iriList       = $state<number[]>([]);   // una entrada por cada clic 2..N
    let lastClickTime = $state(0);
    let isFirstClick  = $state(true);

    type ResponseEntry = { level: number; latency: number; tipo: 'frl' | 'iri' };
    let responseLog = $state<ResponseEntry[]>([]);

    // Estadísticas derivadas — FRL
    const avgFRL = $derived(frlList.length > 0 ? frlList.reduce((a,b)=>a+b,0)/frlList.length : null);
    const sdFRL  = $derived(calculateSD(frlList));
    // Estadísticas derivadas — IRI
    const avgIRI = $derived(iriList.length > 0 ? iriList.reduce((a,b)=>a+b,0)/iriList.length : null);
    const sdIRI  = $derived(calculateSD(iriList));

    function calculateSD(values: number[]): number {
        if (values.length < 2) return 0;
        const mean     = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);
        return Math.sqrt(variance);
    }

    function fmtN(value: number | null): string {
        if (value === null) return 'N/A';
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }

    // Web Audio API — latencia casi cero vs HTMLAudioElement (especialmente en Android)
    let audioCtx: AudioContext | null = null;
    const audioBuffers: Record<string, AudioBuffer> = {};

    async function initAudio() {
        if (typeof window === 'undefined') return;
        audioCtx = new AudioContext();
        await Promise.all(
            (['pop', 'levelup', 'error'] as const).map(async name => {
                const res = await fetch(`/Soundsmemoria/${name}.mp3`);
                const arr = await res.arrayBuffer();
                audioBuffers[name] = await audioCtx!.decodeAudioData(arr);
            })
        );
    }

    if (typeof window !== 'undefined') initAudio();

    function playSound(file: 'pop' | 'levelup' | 'error') {
        if (!audioCtx || !audioBuffers[file]) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffers[file];
        src.connect(audioCtx.destination);
        src.start(0);
    }

    // Pausa si la pestaña pierde visibilidad durante un ensayo (igual que GoNoGo)
    $effect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'hidden' && (phase === 'memo' || phase === 'test')) {
                // Incrementar sessionId cancela cualquier animación en curso.
                // Se va a 'pausado' en lugar de 'inicio' para avisar al evaluador
                // y evitar que los datos recolectados hasta ahora se pierdan silenciosamente.
                sessionId++;
                phase = 'pausado';
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    });

    async function iniciarNivel() {
        sessionId++;
        const mySession = sessionId;
        userSequence = [];
        activeId     = null;
        feedback     = 'none';

        const seqLen = inPractice ? PRACTICE_SEQ_LEN : level;
        // Generación con crypto RNG (mismo estándar que GoNoGo)
        const buf = new Uint32Array(seqLen * 4);
        crypto.getRandomValues(buf);
        const nuevaSecuencia: number[] = [];
        let bi = 0;
        for (let i = 0; i < seqLen; i++) {
            let next: number;
            do { next = buf[bi++] % 12; if (bi >= buf.length) { crypto.getRandomValues(buf); bi = 0; } }
            while (i > 0 && next === nuevaSecuencia[i - 1]);
            nuevaSecuencia.push(next);
        }
        sequence = nuevaSecuencia;

        // Fase memo con RAF para alinear cada cambio de estímulo al frame
        phase = 'memo';
        for (const id of sequence) {
            // Pausa antes de encender el nodo (alineada al frame)
            await new Promise<void>(r => {
                setTimeout(() => requestAnimationFrame(() => r()), 600);
            });
            if (sessionId !== mySession) return;
            activeId = id;
            // Pausa mientras el nodo está encendido (alineada al frame)
            await new Promise<void>(r => {
                setTimeout(() => requestAnimationFrame(() => r()), 800);
            });
            if (sessionId !== mySession) return;
            activeId = null;
        }
        phase        = 'test';
        isFirstClick = true;
        // Esperar a que el DOM renderice la pantalla de test antes de
        // iniciar el cronómetro — garantiza que el estímulo es visible
        await tick();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (sessionId === mySession) lastClickTime = performance.now();
            });
        });
    }

    async function manejarClick(id: number) {
        if (phase !== 'test' || feedback !== 'none') return;

        const ahora   = performance.now();
        const latency = ahora - lastClickTime;
        lastClickTime = ahora;

        // Solo registrar métricas en niveles reales (fuera de práctica)
        if (!isPractice) {
            if (isFirstClick) {
                frlList.push(latency);
                responseLog.push({ level, latency, tipo: 'frl' });
            } else {
                iriList.push(latency);
                responseLog.push({ level, latency, tipo: 'iri' });
            }
        }
        isFirstClick = false;

        if (id === sequence[userSequence.length]) {
            activeId = id;
            playSound('pop');
            userSequence.push(id);
            setTimeout(() => { if (phase === 'test') activeId = null; }, 250);

            if (userSequence.length === sequence.length) {
                feedback = 'success';
                playSound('levelup');
                await new Promise(r => setTimeout(r, 1200));
                if (inPractice) {
                    practiceCount++;
                    if (practiceCount < PRACTICE_TOTAL) {
                        iniciarNivel();
                    } else {
                        phase = 'practica-completada';
                    }
                } else {
                    level++;
                    iniciarNivel();
                }
            }
        } else {
            feedback = 'error';
            playSound('error');
            await new Promise(r => setTimeout(r, 1500));
            if (inPractice) {
                practiceCount++;
                if (practiceCount < PRACTICE_TOTAL) {
                    iniciarNivel();
                } else {
                    phase = 'practica-completada';
                }
            } else {
                totalErrors++;
                phase = 'reporte';
                guardarResultados();
            }
        }
    }

    function iniciarPractica() {
        inPractice    = true;
        practiceCount = 0;
        level         = 1;
        totalErrors   = 0;
        frlList       = [];
        iriList       = [];
        responseLog   = [];
        iniciarNivel();
    }

    function iniciarTestReal() {
        inPractice  = false;
        level       = 1;
        totalErrors = 0;
        frlList     = [];
        iriList     = [];
        responseLog = [];
        iniciarNivel();
    }

    async function guardarResultados() {
        guardandoResultados = true;
        errorGuardado       = null;
        resultadoGuardado   = false;

        const { error } = await supabase.from('secuencia').insert({
            evaluacion_id:                      evaluacion_id ?? null,
            span_maximo:                        level - 1,
            errores_totales:                    totalErrors,
            frl_promedio:                       avgFRL,
            frl_sd:                             sdFRL,
            iri_promedio:                       avgIRI,
            iri_sd:                             sdIRI,
            total_respuestas:                   frlList.length + iriList.length,
        });

        if (error) {
            console.error('Error al guardar en Supabase:', error);
            errorGuardado = 'No se pudieron guardar los resultados. Intenta de nuevo.';
        } else {
            resultadoGuardado = true;
        }
        guardandoResultados = false;
    }

    // ── Descarga PDF (html2canvas + resumen numérico, igual que GoNoGo) ──────
    async function descargarPDF() {
        if (typeof window === 'undefined') return;
        const { jsPDF }   = await import('jspdf');
        const html2canvas = (await import('html2canvas')).default;
        const el          = document.getElementById('results-section');
        if (!el) return;

        const canvas    = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        const imgData   = canvas.toDataURL('image/png');
        const doc       = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageW     = doc.internal.pageSize.getWidth();
        const pageH     = doc.internal.pageSize.getHeight();

        // Página 1: captura visual
        doc.setFontSize(18);
        doc.text('Reporte Memoria Visoespacial – Secuencia', pageW / 2, 32, { align: 'center' });

        const imgW      = pageW - 40;
        const imgHFull  = (canvas.height * imgW) / canvas.width;
        const maxImgH   = pageH - 55;

        if (imgHFull <= maxImgH) {
            doc.addImage(imgData, 'PNG', 20, 45, imgW, imgHFull);
        } else {
            const pxPerPt   = canvas.width / imgW;
            const sliceHpt  = pageH - 55;
            const sliceHpx  = Math.round(sliceHpt * pxPerPt);
            let   offsetY   = 0;
            while (offsetY < canvas.height) {
                const thisSlice = Math.min(sliceHpx, canvas.height - offsetY);
                const tmp       = document.createElement('canvas');
                tmp.width       = canvas.width;
                tmp.height      = thisSlice;
                tmp.getContext('2d')!.drawImage(canvas, 0, -offsetY);
                const sliceData = tmp.toDataURL('image/png');
                doc.addImage(sliceData, 'PNG', 20, 45, imgW, (thisSlice * imgW) / canvas.width);
                offsetY += thisSlice;
                if (offsetY < canvas.height) doc.addPage();
            }
        }

        // Última página: resumen numérico
        doc.addPage();
        doc.setFontSize(14);
        doc.text('Resumen de Resultados', 20, 40);
        doc.setFontSize(11);

        const resumen = [
            `Generado el:                        ${new Date().toLocaleString()}`,
            `Span Máximo (nivel alcanzado):       ${level - 1}`,
            `Total respuestas:                    ${frlList.length + iriList.length}`,
            `--- Latencia 1ª Respuesta (FRL) ---`,
            `FRL Promedio:                        ${fmtN(avgFRL)} ms`,
            `FRL Desviación Estándar:             ${fmtN(sdFRL)} ms`,
            `--- Intervalo Inter-Respuesta (IRI) ---`,
            `IRI Promedio:                        ${fmtN(avgIRI)} ms`,
            `IRI Desviación Estándar:             ${fmtN(sdIRI)} ms`,
        ];
        resumen.forEach((line, i) => doc.text(line, 20, 68 + i * 22));

        if (Capacitor.isNativePlatform()) {
            const base64 = doc.output('datauristring').split(',')[1];
            try {
                const result = await Filesystem.writeFile({
                    path: 'reporte-memoria-secuencia.pdf',
                    data: base64,
                    directory: Directory.Cache
                });
                await Share.share({
                    title: 'Reporte Memoria Visoespacial',
                    files: [result.uri],
                    dialogTitle: 'Compartir reporte'
                });
            } catch (err) {
                console.error('Error al compartir PDF:', err);
                alert('No se pudo compartir el PDF. Revisa los permisos de la app.');
            }
        } else {
            doc.save('Reporte_Memoria_Secuencia.pdf');
        }
    }

    // ── Descarga Excel (resumen + detalle por respuesta) ─────────────────────
    async function descargarExcel() {
        const summaryData = [
            ['Métrica', 'Valor'],
            ['Fecha de Generación',                    new Date().toLocaleString()],
            ['Span Máximo (nivel alcanzado)',          level - 1],
            ['Total respuestas',                       frlList.length + iriList.length],
            ['FRL Promedio (ms)',                      avgFRL !== null ? avgFRL.toFixed(2) : 'N/A'],
            ['FRL Desviación Estándar (ms)',           sdFRL.toFixed(2)],
            ['IRI Promedio (ms)',                      avgIRI !== null ? avgIRI.toFixed(2) : 'N/A'],
            ['IRI Desviación Estándar (ms)',           sdIRI.toFixed(2)],
        ];

        const detailData: (string | number)[][] = [['Respuesta #', 'Nivel', 'Tipo', 'Latencia (ms)']];
        responseLog.forEach((r, i) => {
            detailData.push([i + 1, r.level, r.tipo === 'frl' ? 'Primera Respuesta' : 'Inter-Respuesta', parseFloat(r.latency.toFixed(2))]);
        });

        const wb     = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailData),  'Respuestas Detalladas');
        const wbout  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob   = new Blob([wbout], { type: 'application/octet-stream' });

        if (Capacitor.isNativePlatform()) {
            const base64 = await blobToBase64(blob);
            try {
                const result = await Filesystem.writeFile({
                    path: 'data-memoria-secuencia.xlsx',
                    data: base64,
                    directory: Directory.Cache
                });
                await Share.share({
                    title: 'Reporte Memoria Visoespacial Excel',
                    files: [result.uri],
                    dialogTitle: 'Compartir reporte Excel'
                });
            } catch (err) {
                console.error('Error al compartir Excel:', err);
                alert('Error al compartir el Excel.');
            }
        } else {
            const url = URL.createObjectURL(blob);
            const a   = document.createElement('a');
            a.href    = url;
            a.download = 'Data_Memoria_Secuencia.xlsx';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    function blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader     = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror   = reject;
            reader.readAsDataURL(blob);
        });
    }
</script>

<div class="canvas">
    {#if phase === 'inicio'}
        <div class="intro-card animate-in">
            <h1 class="title">Secuencia de Colores</h1>
            <p class="intro-sub">Memoriza el orden en que se iluminan los nodos y repítelo</p>

            <div class="seq-pasos">
                <div class="seq-paso">
                    <div class="paso-icono" style="background:#ede9fe; color:#6366f1">👁</div>
                    <div class="paso-texto">
                        <strong>Observa</strong>
                        <span>Los nodos se iluminan uno a uno</span>
                    </div>
                </div>
                <div class="paso-conector">↓</div>
                <div class="seq-paso">
                    <div class="paso-icono" style="background:#dcfce7; color:#16a34a">👆</div>
                    <div class="paso-texto">
                        <strong>Repite</strong>
                        <span>Toca los mismos nodos en el mismo orden</span>
                    </div>
                </div>
                <div class="paso-conector">↓</div>
                <div class="seq-paso">
                    <div class="paso-icono" style="background:#fef9c3; color:#ca8a04">📈</div>
                    <div class="paso-texto">
                        <strong>Avanza</strong>
                        <span>Cada nivel añade un nodo más a la secuencia</span>
                    </div>
                </div>
            </div>

            <div class="actions-stack">
                <button class="btn-primary" onclick={iniciarPractica}>Comenzar Prueba</button>
                {#if onVolver}
                    <button class="btn-outline-pill" onclick={onVolver}>Volver</button>
                {/if}
            </div>
        </div>

    {:else if phase === 'memo' || phase === 'test'}
        <div class="game-container animate-in">
            <div class="top-nav">
                <button class="btn-outline-pill small" onclick={() => { sessionId++; phase = 'inicio'; }}>Salir</button>
                <div class="level-badge">
                    {#if isPractice}
                        Práctica {practiceCount + 1}/{PRACTICE_TOTAL}
                    {:else}
                        Nivel {level}
                    {/if}
                </div>
            </div>

            <h2 class="status {phase}">{phase === 'memo' ? 'Memorizar' : '¡VAMOS!'}</h2>

            <div class="board-relative">
                <div class="grid-4x3">
                    {#each NODES as node (node.id)}
                        <button
                            type="button"
                            aria-label="Nodo {node.id + 1}"
                            class="node"
                            style="background-color: {activeId === node.id ? NODE_COLORS[node.id] : '#f1f5f9'}; border: 2px solid {activeId === node.id ? NODE_COLORS[node.id] : '#e2e8f0'};"
                            onclick={() => manejarClick(node.id)}
                        ></button>
                    {/each}
                </div>

                {#if feedback !== 'none'}
                    <div class="feedback-overlay {feedback}">
                        {#if feedback === 'success'}
                            {@html SvgChulito}
                        {:else}
                            {@html SvgEquis}
                        {/if}
                    </div>
                {/if}
            </div>
        </div>

    {:else if phase === 'practica-completada'}
        <div class="glass-card animate-in">
            <div class="icon success-icon">✓</div>
            <h2 class="title">¡Bien!</h2>
            <p class="desc">Ya conoces cómo funciona la prueba. ¡Ahora a iniciar de verdad!</p>
            <div class="actions-stack">
                <button class="btn-primary" onclick={iniciarTestReal}>Iniciar Prueba</button>
            </div>
        </div>

    {:else if phase === 'reporte'}
        <div class="report-wrapper animate-in">
            <div id="results-section">
                <h2 class="report-title">Resultados de la Prueba</h2>
                <p class="report-subtitle">Memoria Visoespacial · {new Date().toLocaleDateString()}</p>

                {#if guardandoResultados}
                    <p class="guardado-estado">Guardando resultados…</p>
                {:else if errorGuardado}
                    <p class="guardado-error">{errorGuardado}
                        <button onclick={guardarResultados}>Reintentar</button>
                    </p>
                {:else if resultadoGuardado}
                    <p class="guardado-ok">Resultados guardados correctamente.</p>
                {/if}

                <div class="results-grid">
                    <div class="r-card r-span">
                        <h3>Span Máximo</h3>
                        <p class="big">{level - 1}</p>
                        <p class="rdesc">Amplitud máxima de memoria visoespacial</p>
                    </div>
                    <div class="r-card r-frl">
                        <h3>Latencia 1ª Respuesta</h3>
                        <p class="big">{fmtN(avgFRL)} ms</p>
                        <p class="rdesc">Tiempo desde estímulo visible hasta primer clic</p>
                    </div>
                    <div class="r-card r-frl-sd">
                        <h3>SD Latencia 1ª Respuesta</h3>
                        <p class="big">{fmtN(sdFRL)} ms</p>
                        <p class="rdesc">Consistencia al iniciar la reproducción</p>
                    </div>
                    <div class="r-card r-iri">
                        <h3>IRI Promedio</h3>
                        <p class="big">{fmtN(avgIRI)} ms</p>
                        <p class="rdesc">Intervalo medio entre respuestas consecutivas</p>
                    </div>
                    <div class="r-card r-iri-sd">
                        <h3>SD IRI</h3>
                        <p class="big">{fmtN(sdIRI)} ms</p>
                        <p class="rdesc">Variabilidad en la ejecución de la secuencia</p>
                    </div>
                </div>
            </div>

            <div class="download-stack">
                <button class="btn-download pdf" onclick={descargarPDF}>Descargar PDF</button>
                <button class="btn-download excel" onclick={descargarExcel}>Descargar Excel</button>
            </div>

            <div class="actions-stack report-footer">
                {#if onTerminar}
                    <button class="btn-primary" onclick={onTerminar}>Continuar evaluación →</button>
                {/if}
                <button class="btn-primary" style="background:#334155" onclick={iniciarPractica}>Reintentar prueba</button>
                {#if !modoEvaluacion}
                    <button class="btn-outline-pill" onclick={() => onVolver ? onVolver() : phase = 'inicio'}>Finalizar</button>
                {/if}
            </div>
        </div>

    {:else if phase === 'pausado'}
        <div class="glass-card animate-in">
            <div class="icon error-icon" style="color:#f59e0b">⚠</div>
            <h2 class="title">Prueba interrumpida</h2>
            <p class="desc">
                La pantalla perdió el foco durante un ensayo activo.
                Para garantizar la validez de los tiempos de reacción,
                la prueba debe reiniciarse desde el principio.
            </p>
            <div class="actions-stack">
                <button class="btn-primary" onclick={() => { phase = 'inicio'; }}>Reiniciar prueba</button>
                {#if onVolver && !modoEvaluacion}
                    <button class="btn-outline-pill" onclick={onVolver}>Volver al menú</button>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .canvas { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f0f4f8; font-family: 'Segoe UI', system-ui, sans-serif; padding: 20px; }

    /* Inicio */
    .glass-card { background: white; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center; width: 350px; }
    .title { font-size: 2rem; font-weight: 800; color: #1e293b; margin: 0 0 0.4rem; }
    .desc  { color: #64748b; margin: 0; }
    .icon  { font-size: 3rem; font-weight: bold; margin-bottom: 10px; }
    .success-icon { color: #16a34a; }

    .actions-stack { display: flex; flex-direction: column; gap: 12px; margin-top: 1.5rem; }

    .btn-primary { background: #1e293b; color: white; border: none; padding: 1rem; border-radius: 1rem; width: 100%; font-weight: 700; cursor: pointer; font-size: 1rem; }
    .btn-primary:hover { background: #0f172a; }

    .btn-outline-pill { background: transparent; border: 2px solid #d1d9e6; color: #4a90e2; padding: 12px 30px; border-radius: 50px; font-size: 1.1rem; font-weight: 500; cursor: pointer; transition: all 0.2s ease; width: 100%; display: flex; justify-content: center; align-items: center; }
    .btn-outline-pill:hover { background-color: #f0f4f8; border-color: #4a90e2; }
    .btn-outline-pill.small { padding: 6px 20px; font-size: 0.9rem; width: auto; }

    /* Juego */
    .game-container { width: 100%; max-width: 600px; display: flex; flex-direction: column; align-items: center; }
    .top-nav { display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 2rem; }
    .level-badge { background: #e2e8f0; padding: 5px 15px; border-radius: 20px; font-weight: bold; color: #475569; }

    .status { font-size: 2.5rem; font-weight: 900; margin-bottom: 2rem; text-align: center; }
    .status.memo { color: #6366f1; }
    .status.test { color: #10b981; }

    .board-relative { position: relative; width: 100%; max-width: 500px; }
    .grid-4x3 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .node { aspect-ratio: 1/1; border-radius: 1rem; cursor: pointer; transition: transform 0.1s, background-color 0.15s; }
    .node:active { transform: scale(0.93); }

    .feedback-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 1.5rem; z-index: 10; animation: popScale 0.3s ease-out; backdrop-filter: blur(2px); }
    .feedback-overlay.success { background: rgba(16,185,129,0.05); }
    .feedback-overlay.error   { background: rgba(239,68,68,0.05); }
    :global(.icon-chulo), :global(.icon-equis) { width: 140px; height: 140px; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.1)); }

    /* Reporte */
    .report-wrapper { background: white; padding: 2rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); width: min(620px, 100%); }

    #results-section { padding-bottom: 1rem; }

    .report-title    { font-size: 1.5rem; font-weight: 800; color: #1e293b; margin: 0 0 4px; text-align: center; }
    .report-subtitle { font-size: 0.85rem; color: #94a3b8; text-align: center; margin: 0 0 0.5rem; }
    .guardado-estado { color: #94a3b8; font-size: 0.85rem; text-align: center; margin: 0 0 1rem; }
    .guardado-ok     { color: #16a34a; font-size: 0.85rem; text-align: center; margin: 0 0 1rem; }
    .guardado-error  { color: #dc2626; font-size: 0.85rem; text-align: center; margin: 0 0 1rem; display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
    .guardado-error button { padding: 4px 12px; font-size: 0.8rem; border-radius: 999px; border: 1px solid #dc2626; background: transparent; color: #dc2626; cursor: pointer; }

    .results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }

    .r-card { padding: 1rem; border-radius: 1rem; }
    .r-card h3 { font-size: 0.85rem; font-weight: 600; margin: 0 0 6px; color: inherit; }
    .r-card .big { font-size: 2rem; font-weight: 800; margin: 0; }

    .rdesc { font-size: 0.75rem; margin: 6px 0 0; opacity: 0.65; line-height: 1.4; font-style: italic; }

    .r-span   { background: linear-gradient(135deg, #dbeafe, #bfdbfe); color: #1e3a8a; }
    .r-errors { background: linear-gradient(135deg, #fee2e2, #fecaca); color: #7f1d1d; }
    .r-frl    { background: linear-gradient(135deg, #f3e8ff, #e9d5ff); color: #4c1d95; }
    .r-frl-sd { background: linear-gradient(135deg, #ede9fe, #ddd6fe); color: #3b0764; }
    .r-iri    { background: linear-gradient(135deg, #dcfce7, #bbf7d0); color: #14532d; }
    .r-iri-sd { background: linear-gradient(135deg, #fef9c3, #fef08a); color: #713f12; }

    .download-stack { display: flex; gap: 8px; margin: 1.5rem 0 0; }
    .btn-download { flex: 1; border: none; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
    .btn-download.pdf   { background: #fee2e2; color: #991b1b; }
    .btn-download.excel { background: #dcfce7; color: #166534; }
    .btn-download:hover { filter: brightness(0.95); }

    .report-footer { border-top: 1px solid #f1f5f9; padding-top: 1rem; margin-top: 1rem; }
    .practice-tag { background: #fef9c3; color: #713f12; font-size: 0.7rem; font-weight: 700; padding: 2px 7px; border-radius: 20px; margin-left: 6px; vertical-align: middle; }

    @keyframes popScale { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .animate-in { animation: fadeIn 0.4s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

    /* ── Intro card (Secuencia) ──────────────────────────────────────── */
    .intro-card { background: white; padding: 2rem 1.75rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); width: min(400px, 100%); text-align: center; }
    .intro-sub { color: #475569; font-size: 1.05rem; margin: 0 0 1.5rem; line-height: 1.5; font-weight: 500; }

    .seq-pasos { display: flex; flex-direction: column; align-items: center; gap: 0; margin-bottom: 1.5rem; text-align: left; }
    .seq-paso { display: flex; align-items: center; gap: 14px; width: 100%; background: #f8fafc; border-radius: 1rem; padding: 14px 16px; }
    .paso-icono { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0; }
    .paso-texto { display: flex; flex-direction: column; gap: 3px; }
    .paso-texto strong { font-size: 1.05rem; color: #1e293b; }
    .paso-texto span   { font-size: 0.88rem; color: #64748b; line-height: 1.4; }
    .paso-conector { font-size: 1.1rem; color: #cbd5e1; padding: 4px 0; }
</style>
