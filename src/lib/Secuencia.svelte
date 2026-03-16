<script lang="ts">
    import * as XLSX from "xlsx";
    import { supabase } from './supabaseClient';

    const SvgChulito = `<svg viewBox="0 0 100 100" class="icon-chulo"><path d="M20 50 L45 75 L80 25" fill="none" stroke="#4ade80" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const SvgEquis   = `<svg viewBox="0 0 100 100" class="icon-equis"><path d="M25 25 L75 75 M75 25 L25 75" fill="none" stroke="#f87171" stroke-width="12" stroke-linecap="round"/></svg>`;

    // Color único por nodo (mostrado durante la fase memo)
    const NODE_COLORS = [
        '#6366f1', '#ec4899', '#f59e0b', '#10b981',
        '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6',
        '#f97316', '#84cc16', '#06b6d4', '#a855f7',
    ];

    let { onVolver, modoEvaluacion = false } = $props<{ onVolver?: () => void; modoEvaluacion?: boolean }>();

    // ── Estado de guardado ────────────────────────────────────────────────────
    let guardandoResultados = $state(false);
    let errorGuardado       = $state<string | null>(null);
    let resultadoGuardado   = $state(false);

    const NODES = Array.from({ length: 12 }, (_, i) => ({ id: i }));

    let phase        = $state<'inicio' | 'memo' | 'test' | 'reporte'>('inicio');
    let sessionId    = $state(0);
    let feedback     = $state<'none' | 'success' | 'error'>('none');
    let sequence     = $state<number[]>([]);
    let userSequence = $state<number[]>([]);
    let activeId     = $state<number | null>(null);
    let level        = $state(1);
    let totalErrors  = $state(0);

    // Métricas científicas
    let latencies     = $state<number[]>([]);
    let lastClickTime = $state(0);
    type ResponseEntry = { level: number; latency: number };
    let responseLog   = $state<ResponseEntry[]>([]);

    // Estadísticas derivadas
    const avgLat = $derived(
        latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null
    );
    const sdLat  = $derived(calculateSD(latencies));
    const minLat = $derived(latencies.length > 0 ? Math.min(...latencies) : null);
    const maxLat = $derived(latencies.length > 0 ? Math.max(...latencies) : null);

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

    function playSound(file: 'pop' | 'levelup' | 'error') {
        const audio = new Audio(`/Soundsmemoria/${file}.mp3`);
        audio.volume = 0.4;
        audio.play().catch(() => {});
    }

    async function iniciarNivel() {
        sessionId++;
        const mySession = sessionId;
        userSequence = [];
        activeId     = null;
        feedback     = 'none';

        const nuevaSecuencia: number[] = [];
        for (let i = 0; i < level; i++) {
            let next;
            do { next = Math.floor(Math.random() * 12); }
            while (i > 0 && next === nuevaSecuencia[i - 1]);
            nuevaSecuencia.push(next);
        }
        sequence = nuevaSecuencia;

        phase = 'memo';
        for (const id of sequence) {
            await new Promise(r => setTimeout(r, 600));
            if (sessionId !== mySession) return;
            activeId = id;
            await new Promise(r => setTimeout(r, 800));
            if (sessionId !== mySession) return;
            activeId = null;
        }
        phase         = 'test';
        lastClickTime = performance.now();
    }

    async function manejarClick(id: number) {
        if (phase !== 'test' || feedback !== 'none') return;

        const ahora   = performance.now();
        const latency = ahora - lastClickTime;
        latencies.push(latency);
        responseLog.push({ level, latency });
        lastClickTime = ahora;

        if (id === sequence[userSequence.length]) {
            activeId = id;
            playSound('pop');
            userSequence.push(id);
            setTimeout(() => { if (phase === 'test') activeId = null; }, 250);

            if (userSequence.length === sequence.length) {
                feedback = 'success';
                playSound('levelup');
                await new Promise(r => setTimeout(r, 1200));
                level++;
                iniciarNivel();
            }
        } else {
            feedback = 'error';
            totalErrors++;
            playSound('error');
            await new Promise(r => setTimeout(r, 1500));
            phase = 'reporte';
            if (!modoEvaluacion) guardarResultados();
        }
    }

    async function guardarResultados() {
        guardandoResultados = true;
        errorGuardado       = null;
        resultadoGuardado   = false;

        const { error } = await supabase.from('secuencia').insert({
            span_maximo:         level - 1,
            latencia_promedio:   avgLat,
            desviacion_estandar: sdLat,
            latencia_minima:     minLat,
            latencia_maxima:     maxLat,
            total_respuestas:    latencies.length,
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
            `Generado el:                  ${new Date().toLocaleString()}`,
            `Span Máximo (nivel alcanzado): ${level - 1}`,
            `Respuestas Registradas:        ${latencies.length}`,
            `Latencia Promedio:             ${fmtN(avgLat)} ms`,
            `Desviación Estándar (muestral):${fmtN(sdLat)} ms`,
            `Latencia Mínima:               ${fmtN(minLat)} ms`,
            `Latencia Máxima:               ${fmtN(maxLat)} ms`,
        ];
        resumen.forEach((line, i) => doc.text(line, 20, 68 + i * 22));

        doc.save('Reporte_Memoria_Secuencia.pdf');
    }

    // ── Descarga Excel (resumen + detalle por respuesta) ─────────────────────
    function descargarExcel() {
        const summaryData = [
            ['Métrica', 'Valor'],
            ['Fecha de Generación',           new Date().toLocaleString()],
            ['Span Máximo (nivel alcanzado)', level - 1],
            ['Respuestas Registradas',        latencies.length],
            ['Latencia Promedio (ms)',         avgLat !== null ? avgLat.toFixed(2) : 'N/A'],
            ['Desviación Estándar (ms)',       sdLat.toFixed(2)],
            ['Latencia Mínima (ms)',           minLat !== null ? minLat.toFixed(2) : 'N/A'],
            ['Latencia Máxima (ms)',           maxLat !== null ? maxLat.toFixed(2) : 'N/A'],
        ];

        const detailData: (string | number)[][] = [['Respuesta #', 'Nivel', 'Latencia (ms)']];
        responseLog.forEach((r, i) => {
            detailData.push([i + 1, r.level, parseFloat(r.latency.toFixed(2))]);
        });

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailData),  'Respuestas Detalladas');
        XLSX.writeFile(wb, 'Data_Memoria_Secuencia.xlsx');
    }
</script>

<div class="canvas">
    {#if phase === 'inicio'}
        <div class="glass-card animate-in">
            <h1 class="title">Memorizar</h1>
            <p class="desc">Tarea de amplitud de memoria visoespacial.</p>
            <div class="actions-stack">
                <button class="btn-primary" onclick={iniciarNivel}>Comenzar Prueba</button>
                {#if onVolver}
                    <button class="btn-outline-pill" onclick={onVolver}>Volver</button>
                {/if}
            </div>
        </div>

    {:else if phase === 'memo' || phase === 'test'}
        <div class="game-container animate-in">
            <div class="top-nav">
                <button class="btn-outline-pill small" onclick={() => { sessionId++; phase = 'inicio'; }}>Salir</button>
                <div class="level-badge">Nivel {level}</div>
            </div>

            <h2 class="status {phase}">{phase === 'memo' ? 'Memorizar' : '¡VAMOS!'}</h2>

            <div class="board-relative">
                <div class="grid-4x3">
                    {#each NODES as node (node.id)}
                        <button
                            type="button"
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
                    <div class="r-card r-avg">
                        <h3>Latencia Promedio</h3>
                        <p class="big">{fmtN(avgLat)} ms</p>
                        <p class="rdesc">Tiempo medio entre estímulo y respuesta</p>
                    </div>
                    <div class="r-card r-sd">
                        <h3>Desviación Estándar</h3>
                        <p class="big">{fmtN(sdLat)} ms</p>
                        <p class="rdesc">Variabilidad en tiempos de respuesta</p>
                    </div>
                    <div class="r-card r-min">
                        <h3>Latencia Mínima</h3>
                        <p class="big">{fmtN(minLat)} ms</p>
                        <p class="rdesc">Respuesta más rápida registrada</p>
                    </div>
                    <div class="r-card r-max">
                        <h3>Latencia Máxima</h3>
                        <p class="big">{fmtN(maxLat)} ms</p>
                        <p class="rdesc">Respuesta más lenta registrada</p>
                    </div>
                </div>
            </div>

            <div class="download-stack">
                <button class="btn-download pdf" onclick={descargarPDF}>Descargar PDF</button>
                <button class="btn-download excel" onclick={descargarExcel}>Descargar Excel</button>
            </div>

            <div class="actions-stack report-footer">
                <button class="btn-primary" onclick={() => { level = 1; latencies = []; responseLog = []; totalErrors = 0; iniciarNivel(); }}>Reintentar</button>
                <button class="btn-outline-pill" onclick={() => onVolver ? onVolver() : phase = 'inicio'}>Finalizar</button>
            </div>
        </div>
    {/if}
</div>

<style>
    .canvas { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f8fafc; font-family: 'Segoe UI', system-ui, sans-serif; padding: 20px; }

    /* Inicio */
    .glass-card { background: white; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center; width: 350px; }
    .title { font-size: 2rem; font-weight: 800; color: #1e293b; margin: 0 0 0.4rem; }
    .desc  { color: #64748b; margin: 0; }

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
    .r-card .sub  { font-size: 0.78rem; margin: 4px 0 0; opacity: 0.7; }
    .rdesc { font-size: 0.75rem; margin: 6px 0 0; opacity: 0.65; line-height: 1.4; font-style: italic; }

    .r-span   { background: linear-gradient(135deg, #dbeafe, #bfdbfe); color: #1e3a8a; }
    .r-errors { background: linear-gradient(135deg, #fee2e2, #fecaca); color: #7f1d1d; }
    .r-avg    { background: linear-gradient(135deg, #f3e8ff, #e9d5ff); color: #4c1d95; }
    .r-sd     { background: linear-gradient(135deg, #ede9fe, #ddd6fe); color: #3b0764; }
    .r-min    { background: linear-gradient(135deg, #dcfce7, #bbf7d0); color: #14532d; }
    .r-max    { background: linear-gradient(135deg, #fef9c3, #fef08a); color: #713f12; }

    .download-stack { display: flex; gap: 8px; margin: 1.5rem 0 0; }
    .btn-download { flex: 1; border: none; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
    .btn-download.pdf   { background: #fee2e2; color: #991b1b; }
    .btn-download.excel { background: #dcfce7; color: #166534; }
    .btn-download:hover { filter: brightness(0.95); }

    .report-footer { border-top: 1px solid #f1f5f9; padding-top: 1rem; margin-top: 1rem; }

    @keyframes popScale { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .animate-in { animation: fadeIn 0.4s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
</style>
