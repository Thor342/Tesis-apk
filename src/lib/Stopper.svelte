<script lang="ts">
    import * as XLSX from "xlsx";
    import { supabase } from './supabaseClient';
    import { tick } from 'svelte';
    import { Capacitor } from '@capacitor/core';
    import { Filesystem, Directory } from '@capacitor/filesystem';
    import { Share } from '@capacitor/share';

    // ─── Props ────────────────────────────────────────────────────────────────
    let {
        onVolver      = undefined as (() => void) | undefined,
        onTerminar    = undefined as (() => void) | undefined,
        evaluacion_id = undefined as number | undefined,
        modoEvaluacion = false as boolean
    } = $props();

    // ─── Colores ──────────────────────────────────────────────────────────────
    const COLORES = [
        { nombre: 'ROJO',     valor: '#e11d48' },
        { nombre: 'VERDE',    valor: '#16a34a' },
        { nombre: 'AZUL',     valor: '#2563eb' },
        { nombre: 'AMARILLO', valor: '#ca8a04' }
    ];

    // ─── Parámetros de la prueba ──────────────────────────────────────────────
    // 40 ensayos (20 congruentes + 20 incongruentes) es el estándar mínimo
    // para obtener estimaciones fiables del efecto Stroop en adultos.
    // ISI de 500 ms (fijación) entre ensayos previene contaminación temporal de TRs.
    const N_PRACTICA      = 5;    // ~2 congruentes + 3 incongruentes
    const N_TEST          = 40;   // 20 congruentes + 20 incongruentes
    const ISI_MS          = 500;  // Intervalo inter-estímulo (ms)
    const MIN_RT_MS       = 200;  // TR mínimo plausible para tarea de elección-4
    const PRACTICA_UMBRAL = 0.75; // 75% aciertos mínimo para pasar práctica

    // ─── Tipos ────────────────────────────────────────────────────────────────
    type Ensayo   = { texto: string; color: string; esCongruente: boolean };
    type Resultado = {
        acierto:      boolean;
        ms:           number;
        tipo:         'Congruente' | 'Incongruente';
        anticipacion: boolean;
    };

    // ─── Estado ───────────────────────────────────────────────────────────────
    let phase        = $state<'inicio' | 'practica' | 'resultado_practica' | 'test' | 'reporte'>('inicio');
    let listaEnsayos = $state<Ensayo[]>([]);
    let indiceActual = $state(0);
    let tiempoInicio = 0;
    let resultados   = $state<Resultado[]>([]);
    let enISI        = $state(false);
    let isiTimer: ReturnType<typeof setTimeout> | null = null;

    let guardando          = $state(false);
    let guardadoExitoso    = $state(false);
    let errorGuardado      = $state<string | null>(null);
    let practicaExitosa    = $state(false);
    // Orden aleatorio de botones por ensayo — previene aprendizaje espacial-motor.
    let coloresAleatorios  = $state([...COLORES]);

    // ─── Utilidades ───────────────────────────────────────────────────────────
    function calculateSD(values: number[]): number {
        if (values.length < 2) return 0;
        const mean     = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);
        return Math.sqrt(variance);
    }

    function fmtN(v: number | null): string {
        if (v === null) return 'N/A';
        return Number.isInteger(v) ? String(v) : v.toFixed(1);
    }

    function shuffleArray<T>(arr: T[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const buf = new Uint32Array(1);
            crypto.getRandomValues(buf);
            const j = buf[0] % (i + 1);
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    // ─── Generación de estímulos balanceados ──────────────────────────────────
    // Garantiza: 50 % congruentes / 50 % incongruentes,
    //            máximo 3 del mismo tipo en secuencia (evita sesgos de anticipación),
    //            RNG criptográfico para aleatoriedad de calidad científica.
    function generarBloques(cantidad: number): Ensayo[] {
        const half  = Math.floor(cantidad / 2);
        const other = cantidad - half;
        let arr: Ensayo[] = [];
        let attempts = 0;
        do {
            arr = [];
            const tipos: boolean[] = [
                ...Array.from({ length: half  }, () => true),
                ...Array.from({ length: other }, () => false),
            ];
            shuffleArray(tipos);
            for (const esCongruente of tipos) {
                const buf = new Uint32Array(2);
                crypto.getRandomValues(buf);
                const idxTexto = buf[0] % COLORES.length;
                let idxColor = idxTexto;
                if (!esCongruente) {
                    let tries = 0;
                    do {
                        crypto.getRandomValues(buf);
                        idxColor = buf[0] % COLORES.length;
                        tries++;
                    } while (idxColor === idxTexto && tries < 20);
                }
                arr.push({ texto: COLORES[idxTexto].nombre, color: COLORES[idxColor].valor, esCongruente });
            }
            attempts++;
        } while (!noMaxConsecutivos(arr, 3) && attempts < 500);
        return arr;
    }

    function noMaxConsecutivos(arr: Ensayo[], max: number): boolean {
        let count = 1;
        for (let i = 1; i < arr.length; i++) {
            count = arr[i].esCongruente === arr[i - 1].esCongruente ? count + 1 : 1;
            if (count > max) return false;
        }
        return true;
    }

    // ─── Métricas derivadas ───────────────────────────────────────────────────
    // Solo se incluyen en los promedios de TR los ensayos correctos sin anticipación.
    const rtsCong   = $derived(resultados.filter(r => r.tipo === 'Congruente'   && r.acierto && !r.anticipacion).map(r => r.ms));
    const rtsIncong = $derived(resultados.filter(r => r.tipo === 'Incongruente' && r.acierto && !r.anticipacion).map(r => r.ms));

    const mediaC = $derived(rtsCong.length   > 0 ? rtsCong.reduce((a, b) => a + b, 0)   / rtsCong.length   : null);
    const mediaI = $derived(rtsIncong.length > 0 ? rtsIncong.reduce((a, b) => a + b, 0) / rtsIncong.length : null);
    const sdC    = $derived(calculateSD(rtsCong));
    const sdI    = $derived(calculateSD(rtsIncong));

    // Efecto de interferencia Stroop = TR incongruente – TR congruente.
    // Valores normativos en adultos sanos: ~50–150 ms.
    const interferencia = $derived(mediaC !== null && mediaI !== null ? mediaI - mediaC : null);

    const aciertosCong   = $derived(resultados.filter(r => r.tipo === 'Congruente'   && r.acierto).length);
    const aciertosIncong = $derived(resultados.filter(r => r.tipo === 'Incongruente' && r.acierto).length);
    const erroresCong    = $derived(resultados.filter(r => r.tipo === 'Congruente'   && !r.acierto).length);
    const erroresIncong  = $derived(resultados.filter(r => r.tipo === 'Incongruente' && !r.acierto).length);
    const anticipaciones = $derived(resultados.filter(r => r.anticipacion).length);
    const aciertosTotal  = $derived(aciertosCong + aciertosIncong);

    // ─── Flujo de la prueba ───────────────────────────────────────────────────
    function shuffleColores() {
        const arr = [...COLORES];
        shuffleArray(arr);
        coloresAleatorios = arr;
    }

    async function iniciarFase(nuevaFase: 'practica' | 'test') {
        if (isiTimer) { clearTimeout(isiTimer); isiTimer = null; }
        guardadoExitoso = false;
        errorGuardado   = null;
        indiceActual    = 0;
        resultados      = [];
        enISI           = false;
        listaEnsayos    = generarBloques(nuevaFase === 'practica' ? N_PRACTICA : N_TEST);
        shuffleColores();
        phase           = nuevaFase;
        await tick();
        tiempoInicio    = performance.now();
    }

    function registrarRespuesta(valorColor: string) {
        if (enISI) return;

        const ms          = performance.now() - tiempoInicio;
        const anticipacion = ms < MIN_RT_MS;
        const ensayo      = listaEnsayos[indiceActual];
        // Las anticipaciones se registran como error: TR < 200 ms no permite
        // procesamiento perceptivo completo en tarea de elección-4.
        const acierto     = !anticipacion && (valorColor === ensayo.color);

        resultados = [...resultados, {
            acierto,
            ms,
            tipo:        ensayo.esCongruente ? 'Congruente' : 'Incongruente',
            anticipacion
        }];

        indiceActual++;

        if (indiceActual < listaEnsayos.length) {
            // ISI: cruz de fijación ISI_MS ms antes del siguiente estímulo.
            // Previene contaminación temporal entre ensayos consecutivos.
            enISI    = true;
            isiTimer = setTimeout(() => {
                shuffleColores();
                enISI        = false;
                tiempoInicio = performance.now();
            }, ISI_MS);
        } else {
            if (phase === 'practica') {
                practicaExitosa = resultados.filter(r => r.acierto).length >= Math.round(N_PRACTICA * PRACTICA_UMBRAL);
                phase = 'resultado_practica';
            } else {
                if (!modoEvaluacion) phase = 'reporte';
                guardarEnStroop();
            }
        }
    }

    // ─── Guardado en Supabase ─────────────────────────────────────────────────
    async function guardarEnStroop() {
        guardando       = true;
        errorGuardado   = null;
        guardadoExitoso = false;

        // Clasificación del efecto de interferencia (valores normativos en adultos sanos: 50–150 ms)
        const estadoInterferencia = interferencia === null ? 'N/A'
            : interferencia > 150 ? 'ALTO'
            : interferencia > 60  ? 'MODERADO'
            : 'NORMAL';

        const { error } = await supabase.from('resultados_stroop').insert({
            evaluacion_id:          evaluacion_id ?? null,
            // Columnas existentes en BD (nombres originales)
            aciertos_totales:       aciertosTotal,
            total_ensayos:          N_TEST,
            media_congruente_ms:    mediaC !== null ? Math.round(mediaC) : null,
            media_incongruente_ms:  mediaI !== null ? Math.round(mediaI) : null,
            indice_interferencia_ms: interferencia !== null ? Math.round(interferencia) : null,
            version_prueba:         'color-palabra-v1',
            estado_interferencia:   estadoInterferencia,
            // Columnas nuevas (requieren ALTER TABLE — ver instrucciones SQL)
            aciertos_congruente:    aciertosCong,
            aciertos_incongruente:  aciertosIncong,
            errores_congruente:     erroresCong,
            errores_incongruente:   erroresIncong,
            anticipaciones:         anticipaciones,
            rt_congruente_sd:       sdC,
            rt_incongruente_sd:     sdI,
        });

        if (error) {
            console.error('Error al guardar en Supabase:', error);
            errorGuardado = 'No se pudieron guardar los resultados. Intenta de nuevo.';
        } else {
            guardadoExitoso = true;
            if (modoEvaluacion) onTerminar?.();
        }
        guardando = false;
    }

    // ─── Descarga PDF ─────────────────────────────────────────────────────────
    async function descargarPDF() {
        if (typeof window === 'undefined') return;
        const { jsPDF }   = await import('jspdf');
        const html2canvas = (await import('html2canvas')).default;
        const el = document.getElementById('results-section');
        if (!el) return;

        const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        const doc    = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageW  = doc.internal.pageSize.getWidth();
        const pageH  = doc.internal.pageSize.getHeight();
        const imgW   = pageW - 40;

        doc.setFontSize(18);
        doc.text('Reporte Test de Stroop – Color–Palabra', pageW / 2, 32, { align: 'center' });

        const imgHFull = (canvas.height * imgW) / canvas.width;
        if (imgHFull <= pageH - 55) {
            doc.addImage(canvas.toDataURL('image/png'), 'PNG', 20, 45, imgW, imgHFull);
        } else {
            const pxPerPt  = canvas.width / imgW;
            const sliceHpt = pageH - 55;
            const sliceHpx = Math.round(sliceHpt * pxPerPt);
            let offsetY = 0;
            while (offsetY < canvas.height) {
                const thisSlice = Math.min(sliceHpx, canvas.height - offsetY);
                const tmp = document.createElement('canvas');
                tmp.width = canvas.width; tmp.height = thisSlice;
                tmp.getContext('2d')!.drawImage(canvas, 0, -offsetY);
                doc.addImage(tmp.toDataURL('image/png'), 'PNG', 20, 45, imgW, (thisSlice * imgW) / canvas.width);
                offsetY += thisSlice;
                if (offsetY < canvas.height) doc.addPage();
            }
        }

        doc.addPage();
        doc.setFontSize(14);
        doc.text('Resumen de Resultados', 20, 40);
        doc.setFontSize(11);
        const resumen = [
            `Generado el:                          ${new Date().toLocaleString()}`,
            `Total ensayos:                        ${N_TEST}`,
            `Total aciertos:                       ${aciertosTotal} / ${N_TEST}`,
            `Aciertos congruentes:                 ${aciertosCong} / ${N_TEST / 2}`,
            `Aciertos incongruentes:               ${aciertosIncong} / ${N_TEST / 2}`,
            `Errores congruentes:                  ${erroresCong}`,
            `Errores incongruentes:                ${erroresIncong}`,
            `Anticipaciones (< ${MIN_RT_MS} ms):         ${anticipaciones}`,
            `TR promedio congruente:               ${fmtN(mediaC)} ms`,
            `DE TR congruente:                     ${fmtN(sdC)} ms`,
            `TR promedio incongruente:             ${fmtN(mediaI)} ms`,
            `DE TR incongruente:                   ${fmtN(sdI)} ms`,
            `Efecto de interferencia Stroop:       ${fmtN(interferencia)} ms`,
        ];
        resumen.forEach((line, i) => doc.text(line, 20, 68 + i * 22));
        if (Capacitor.isNativePlatform()) {
            const base64 = doc.output('datauristring').split(',')[1];
            try {
                const result = await Filesystem.writeFile({
                    path: 'reporte-stroop.pdf',
                    data: base64,
                    directory: Directory.Cache
                });
                await Share.share({
                    title: 'Reporte Test de Stroop',
                    files: [result.uri],
                    dialogTitle: 'Compartir reporte'
                });
            } catch (err) {
                console.error('Error al compartir PDF:', err);
                alert('No se pudo compartir el PDF. Revisa los permisos de la app.');
            }
        } else {
            doc.save('Reporte_Stroop.pdf');
        }
    }

    // ─── Descarga Excel ───────────────────────────────────────────────────────
    async function descargarExcel() {
        const summaryData: (string | number)[][] = [
            ['Métrica', 'Valor'],
            ['Fecha de Generación',                    new Date().toLocaleString()],
            ['Total Ensayos',                          N_TEST],
            ['Total Aciertos',                         aciertosTotal],
            ['Aciertos Congruentes',                   aciertosCong],
            ['Aciertos Incongruentes',                 aciertosIncong],
            ['Errores Congruentes',                    erroresCong],
            ['Errores Incongruentes',                  erroresIncong],
            [`Anticipaciones (< ${MIN_RT_MS} ms)`,     anticipaciones],
            ['TR Promedio Congruente (ms)',             mediaC !== null ? parseFloat(mediaC.toFixed(2)) : 'N/A'],
            ['DE TR Congruente (ms)',                   parseFloat(sdC.toFixed(2))],
            ['TR Promedio Incongruente (ms)',           mediaI !== null ? parseFloat(mediaI.toFixed(2)) : 'N/A'],
            ['DE TR Incongruente (ms)',                 parseFloat(sdI.toFixed(2))],
            ['Efecto de Interferencia Stroop (ms)',     interferencia !== null ? parseFloat(interferencia.toFixed(2)) : 'N/A'],
        ];

        const detailData: (string | number)[][] = [
            ['Ensayo #', 'Tipo', 'Acierto', 'TR (ms)', 'Anticipación']
        ];
        resultados.forEach((r, i) => {
            detailData.push([
                i + 1,
                r.tipo,
                r.acierto ? 'Sí' : 'No',
                parseFloat(r.ms.toFixed(2)),
                r.anticipacion ? 'Sí' : 'No',
            ]);
        });

        const wb     = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailData),  'Ensayos Detallados');
        const wbout  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob   = new Blob([wbout], { type: 'application/octet-stream' });

        if (Capacitor.isNativePlatform()) {
            const base64 = await blobToBase64(blob);
            try {
                const result = await Filesystem.writeFile({
                    path: 'reporte-stroop.xlsx',
                    data: base64,
                    directory: Directory.Cache
                });
                await Share.share({
                    title: 'Reporte Stroop Excel',
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
            a.download = 'Reporte_Stroop.xlsx';
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
            <p class="intro-sub">Identifica el <strong>color de la tinta</strong>, ignora la palabra</p>

            <div class="stroop-demo">
                <div class="demo-ejemplo">
                    <span class="demo-palabra" style="color: #2563eb">ROJO</span>
                </div>
                <div class="demo-regla">
                    <span class="demo-incorrecto">✗ &nbsp;ROJO</span>
                    <span class="demo-correcto">✓ &nbsp;AZUL</span>
                </div>
                <p class="demo-hint">La palabra dice "ROJO" pero la tinta es <strong style="color:#2563eb">azul</strong> → toca azul</p>
            </div>

            <div class="stroop-colores-demo">
                {#each COLORES as col}
                    <div class="col-chip" style="background:{col.valor}" aria-label={col.nombre}></div>
                {/each}
            </div>
            <p class="intro-chip-hint">Estos son los 4 botones que usarás</p>

            <div class="actions-stack">
                <button class="btn-primary" onclick={() => iniciarFase('practica')}>Comenzar Entrenamiento</button>
                {#if onVolver && !modoEvaluacion}
                    <button class="btn-outline-pill" onclick={onVolver}>Volver al Dashboard</button>
                {/if}
            </div>
        </div>

    {:else if phase === 'practica' || phase === 'test'}
        <div class="game-container animate-in">
            <div class="top-nav">
                <div class="level-badge">
                    {phase === 'practica' ? 'ENTRENAMIENTO' : 'EVALUACIÓN'}: {indiceActual + 1} / {listaEnsayos.length}
                </div>
            </div>

            {#if enISI}
                <div class="fixation-wrap">
                    <span class="fixation">+</span>
                </div>
            {:else}
                <h2 class="stroop-word" style="color: {listaEnsayos[indiceActual]?.color}">
                    {listaEnsayos[indiceActual]?.texto}
                </h2>
                <div class="grid-stroop">
                    {#each coloresAleatorios as col}
                        <button
                            class="btn-stroop-choice"
                            style="background: {col.valor}"
                            onclick={() => registrarRespuesta(col.valor)}
                            aria-label="Color {col.nombre}"
                        ></button>
                    {/each}
                </div>
            {/if}
        </div>

    {:else if phase === 'resultado_practica'}
        <div class="glass-card animate-in">
            {#if practicaExitosa}
                <div class="icon success-icon">✓</div>
                <h2 class="title">¡Muy bien!</h2>
                <p class="desc">Has comprendido la tarea. ¿Listo para la evaluación real?</p>
                <button class="btn-primary" onclick={() => iniciarFase('test')}>Comenzar Evaluación</button>
            {:else}
                <div class="icon error-icon">!</div>
                <h2 class="title">Atención</h2>
                <p class="desc">Recuerda: presiona el <strong>color de la tinta</strong>, no lo que dice el texto.</p>
                <button class="btn-primary" onclick={() => iniciarFase('practica')}>Reintentar Entrenamiento</button>
            {/if}
        </div>

    {:else if phase === 'reporte'}
        <div class="report-wrapper animate-in">
            <div id="results-section">
                <div class="report-header">
                    <h2 class="report-title">Test de Stroop</h2>
                    <p class="report-subtitle">{new Date().toLocaleDateString()}</p>
                </div>

                {#if guardando}
                    <p class="guardado-estado">Guardando resultados…</p>
                {:else if errorGuardado}
                    <p class="guardado-error">{errorGuardado}
                        <button onclick={guardarEnStroop}>Reintentar</button>
                    </p>
                {:else if guardadoExitoso}
                    <p class="guardado-ok">Resultados guardados correctamente.</p>
                {/if}

                <div class="results-grid">
                    <div class="r-card r-span">
                        <h3>Aciertos Totales</h3>
                        <p class="big">{aciertosTotal} <small>/{N_TEST}</small></p>
                    </div>
                    <div class="r-card r-errors">
                        <h3>Interferencia Stroop</h3>
                        <p class="big">{fmtN(interferencia)} <small>ms</small></p>
                        <div class="interpretation-bar">
                            <span>Efecto:</span>
                            <strong>
                                {#if interferencia === null}N/A
                                {:else if interferencia > 150}ALTO
                                {:else if interferencia > 60}MODERADO
                                {:else}NORMAL{/if}
                            </strong>
                        </div>
                    </div>
                    <div class="r-card r-frl">
                        <h3>TR Congruente</h3>
                        <p class="big">{fmtN(mediaC)} <small>ms</small></p>
                        <p class="r-sub">DE: {fmtN(sdC)} ms · Aciertos: {aciertosCong}/{N_TEST/2}</p>
                    </div>
                    <div class="r-card r-iri">
                        <h3>TR Incongruente</h3>
                        <p class="big">{fmtN(mediaI)} <small>ms</small></p>
                        <p class="r-sub">DE: {fmtN(sdI)} ms · Aciertos: {aciertosIncong}/{N_TEST/2}</p>
                    </div>
                    <div class="r-card r-err-c">
                        <h3>Errores Congruentes</h3>
                        <p class="big">{erroresCong}</p>
                    </div>
                    <div class="r-card r-err-i">
                        <h3>Errores Incongruentes</h3>
                        <p class="big">{erroresIncong}</p>
                    </div>
                    {#if anticipaciones > 0}
                    <div class="r-card r-ant">
                        <h3>Anticipaciones (&lt;{MIN_RT_MS} ms)</h3>
                        <p class="big">{anticipaciones}</p>
                    </div>
                    {/if}
                </div>
            </div>

            <div class="download-stack">
                <button class="btn-download pdf" onclick={descargarPDF}>Descargar PDF</button>
                <button class="btn-download excel" onclick={descargarExcel}>Descargar Excel</button>
            </div>

            <div class="actions-stack">
                {#if onTerminar}
                    <button class="btn-primary" onclick={onTerminar}>Continuar evaluación →</button>
                {/if}
                <button class="btn-outline-pill" onclick={() => iniciarFase('practica')}>Reiniciar prueba</button>
                {#if onVolver && !modoEvaluacion}
                    <button class="btn-outline-pill" onclick={onVolver}>Finalizar Sesión</button>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .canvas { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f0f4f8; font-family: system-ui, sans-serif; padding: 20px; }
    .glass-card { background: white; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center; width: min(350px, 100%); }
    .title { font-size: 1.8rem; font-weight: 800; color: #1e293b; margin: 10px 0; }
    .desc { color: #64748b; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .icon { font-size: 3rem; font-weight: bold; margin-bottom: 10px; }
    .success-icon { color: #16a34a; }
    .error-icon { color: #e11d48; }

    .game-container { width: 100%; max-width: 500px; text-align: center; padding: 0 20px; box-sizing: border-box; }
    .top-nav { margin-bottom: 1rem; }
    .level-badge { display: inline-block; background: #e2e8f0; padding: 5px 15px; border-radius: 20px; font-weight: bold; color: #475569; font-size: 0.85rem; }
    .stroop-word { font-size: clamp(2.2rem, 10vw, 4.5rem); font-weight: 900; margin: 2rem 0; user-select: none; word-break: break-word; line-height: 1.1; }
    .fixation-wrap { height: 180px; display: flex; align-items: center; justify-content: center; }
    .fixation { font-size: clamp(2.5rem, 8vw, 4rem); font-weight: 300; color: #94a3b8; user-select: none; }
    .grid-stroop { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .btn-stroop-choice { aspect-ratio: 1.8/1; border-radius: 1.2rem; border: none; cursor: pointer; transition: 0.1s; }
    .btn-stroop-choice:active { transform: scale(0.95); }

    .report-wrapper { background: white; padding: 2rem; border-radius: 2rem; width: min(500px, 100%); box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
    .report-header { text-align: center; margin-bottom: 1rem; }
    .report-title { font-size: 1.4rem; font-weight: 800; color: #1e293b; margin: 0 0 4px; }
    .report-subtitle { font-size: 0.85rem; color: #94a3b8; margin: 0 0 0.75rem; }
    .guardado-estado { color: #94a3b8; font-size: 0.85rem; text-align: center; margin: 0 0 0.5rem; }
    .guardado-ok     { color: #16a34a; font-size: 0.85rem; text-align: center; margin: 0 0 0.5rem; }
    .guardado-error  { color: #dc2626; font-size: 0.85rem; text-align: center; margin: 0 0 0.5rem; display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
    .guardado-error button { padding: 4px 12px; font-size: 0.8rem; border-radius: 999px; border: 1px solid #dc2626; background: transparent; color: #dc2626; cursor: pointer; }

    .results-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 1rem 0; }
    .r-card { padding: 1.2rem; border-radius: 1rem; }
    .r-card h3 { font-size: 0.7rem; text-transform: uppercase; margin: 0; opacity: 0.7; }
    .r-card .big { font-size: 1.8rem; font-weight: 800; margin: 5px 0; }
    .r-card .big small { font-size: 0.8rem; font-weight: 400; }
    .r-sub { font-size: 0.72rem; margin: 4px 0 0; opacity: 0.75; }
    .r-span   { background: #eff6ff; color: #1e40af; }
    .r-frl    { background: #fdf4ff; color: #701a75; }
    .r-iri    { background: #f0fdf4; color: #166534; }
    .r-errors { background: #fff1f2; color: #9f1239; grid-column: span 2; }
    .r-err-c  { background: #fefce8; color: #713f12; }
    .r-err-i  { background: #fff7ed; color: #9a3412; }
    .r-ant    { background: #f1f5f9; color: #475569; grid-column: span 2; }

    .interpretation-bar { display: flex; justify-content: space-between; font-size: 0.75rem; margin-top: 5px; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 5px; }
    .btn-primary { background: #1e293b; color: white; border: none; padding: 1rem; border-radius: 1rem; width: 100%; font-weight: 700; cursor: pointer; font-size: 1rem; }
    .btn-outline-pill { background: transparent; border: 2px solid #e2e8f0; padding: 0.8rem; border-radius: 50px; cursor: pointer; width: 100%; font-weight: 600; color: #64748b; }
    .download-stack { display: flex; gap: 8px; margin: 1rem 0; }
    .btn-download { flex: 1; padding: 10px; border-radius: 8px; border: none; font-weight: 700; cursor: pointer; }
    .pdf   { background: #fee2e2; color: #991b1b; }
    .excel { background: #dcfce7; color: #166534; }
    .actions-stack { display: flex; flex-direction: column; gap: 8px; }
    .animate-in { animation: fadeIn 0.4s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

    /* ── Intro card (Stroop) ─────────────────────────────────────────── */
    .intro-card { background: white; padding: 2rem 1.75rem; border-radius: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.08); width: min(400px, 100%); text-align: center; }
    .intro-sub { color: #475569; font-size: 1.05rem; margin: 0 0 1.5rem; line-height: 1.5; font-weight: 500; }

    .stroop-demo { background: #f8fafc; border-radius: 1.2rem; padding: 1.2rem 1rem; margin-bottom: 1rem; }
    .demo-ejemplo { margin-bottom: 0.6rem; }
    .demo-palabra { font-size: clamp(2rem, 8vw, 3rem); font-weight: 900; user-select: none; }
    .demo-regla { display: flex; justify-content: center; gap: 1.5rem; margin-bottom: 0.6rem; }
    .demo-incorrecto { font-size: 0.95rem; font-weight: 700; color: #dc2626; opacity: 0.7; }
    .demo-correcto   { font-size: 0.95rem; font-weight: 700; color: #16a34a; }
    .demo-hint { font-size: 0.88rem; color: #64748b; margin: 0; line-height: 1.5; }

    .stroop-colores-demo { display: flex; justify-content: center; gap: 10px; margin-bottom: 4px; }
    .col-chip { width: 40px; height: 40px; border-radius: 10px; }
    .intro-chip-hint { font-size: 0.82rem; color: #94a3b8; margin: 0 0 1.25rem; }
</style>
