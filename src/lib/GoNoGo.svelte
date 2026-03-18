<script lang="ts">

    import { tick } from 'svelte';

    import { fly } from 'svelte/transition';

    import { Capacitor } from '@capacitor/core';

    import { Filesystem, Directory } from '@capacitor/filesystem';

    import { Share } from '@capacitor/share';

    import * as XLSX from 'xlsx';

    import { supabase } from './supabaseClient';



    // ─── Props ────────────────────────────────────────────────────────────────

    let {

        onVolver      = undefined as (() => void) | undefined,

        onTerminar    = undefined as (() => void) | undefined,

        onIniciar     = undefined as (() => void) | undefined,

        evaluacion_id = undefined as number | undefined,

        modoEvaluacion = false as boolean

    } = $props();



    // ─── Estado de guardado ───────────────────────────────────────────────────

    let guardandoResultados = $state(false);

    let errorGuardado       = $state<string | null>(null);

    let guardadoExitoso     = $state(false);



    // ─── Types ────────────────────────────────────────────────────────────────

    type Stimulus = { type: 'go' | 'no-go'; color: string };



    type Trial = {

        type: 'go' | 'no-go';

        reactionTime?: number;

        correct: boolean;

        anticipationError: boolean;

        block: 1 | 2 | 'practice';

        isi: number;

        clickTimestamp?: number;

        isPractice: boolean;

        errorType: 'omission' | 'commission' | 'anticipation' | null;

    };



    // ─── Constants ────────────────────────────────────────────────────────────

    const TOTAL_TRIALS   = 100;

    const PRACTICE_COUNT = 5;



    // ─── State ────────────────────────────────────────────────────────────────

    let gameState = $state<

        'start' | 'waiting' | 'stimulus' | 'feedback' |

        'practice-complete' | 'paused' | 'results'

    >('start');



    let isPracticePhase  = $state(false);

    let currentStimulus  = $state<Stimulus | null>(null);

    let startTime        = $state(0);

    let currentTrial     = $state<Trial | null>(null);

    let trials           = $state<Trial[]>([]);

    let trialIndex       = $state(0);

    let clicksFuera      = $state(0);



    // ─── Timer handles ────────────────────────────────────────────────────────

    let rafHandle:        number | null = null;

    let stimulusTimeout:  ReturnType<typeof setTimeout> | null = null;

    let feedbackTimeout:  ReturnType<typeof setTimeout> | null = null;



    // ─── Stimulus sequences ───────────────────────────────────────────────────

    let stimuli:         Stimulus[] = [];

    let practiceStimuli: Stimulus[] = [];

    let currentISI = 0;



    // ─── Derived statistics (real trials only) ────────────────────────────────

    const realTrials      = $derived(trials.filter(t => !t.isPractice));

    const goTrials        = $derived(realTrials.filter(t => t.type === 'go'));

    const noGoTrials      = $derived(realTrials.filter(t => t.type === 'no-go'));

    const goCorrect       = $derived(goTrials.filter(t => t.correct).length);

    const noGoCorrect     = $derived(noGoTrials.filter(t => t.correct).length);

    const goReactionTimes = $derived(

        goTrials

            .filter(t => t.correct && typeof t.reactionTime === 'number' && !t.anticipationError)

            .map(t => t.reactionTime!)

    );

    const avgGo           = $derived(

        goReactionTimes.length > 0

            ? goReactionTimes.reduce((a, b) => a + b, 0) / goReactionTimes.length

            : null

    );

    const sdGo            = $derived(calculateSD(goReactionTimes));

    const minGo           = $derived(goReactionTimes.length > 0 ? Math.min(...goReactionTimes) : null);

    const maxGo           = $derived(goReactionTimes.length > 0 ? Math.max(...goReactionTimes) : null);

    const omissions       = $derived(goTrials.length - goCorrect);

    const commissions     = $derived(noGoTrials.filter(t => !t.correct).length);

    const anticipationErrors = $derived(realTrials.filter(t => t.anticipationError).length);

    const block1RTs       = $derived(

        realTrials.slice(0, 50)

            .filter(t => t.type === 'go' && t.correct && t.reactionTime && !t.anticipationError)

            .map(t => t.reactionTime!)

    );

    const block2RTs       = $derived(

        realTrials.slice(50, 100)

            .filter(t => t.type === 'go' && t.correct && t.reactionTime && !t.anticipationError)

            .map(t => t.reactionTime!)

    );

    const avgFirst     = $derived(block1RTs.length > 0 ? block1RTs.reduce((a, b) => a + b, 0) / block1RTs.length : null);

    const avgLast      = $derived(block2RTs.length > 0 ? block2RTs.reduce((a, b) => a + b, 0) / block2RTs.length : null);

    const totalCorrect = $derived(goCorrect + noGoCorrect);

    const accuracy     = $derived(totalCorrect / TOTAL_TRIALS * 100);



    // ─── Tab-visibility guard ─────────────────────────────────────────────────

    $effect(() => {

        const handleVisibility = () => {

            if (

                document.visibilityState === 'hidden' &&

                (gameState === 'waiting' || gameState === 'stimulus')

            ) {

                clearTimers();

                gameState = 'paused';

            }

        };

        document.addEventListener('visibilitychange', handleVisibility);

        return () => document.removeEventListener('visibilitychange', handleVisibility);

    });



    // ─── Utilities ────────────────────────────────────────────────────────────

    function fmtNumber(value: number | null) {

        if (value === null) return 'N/A';

        return Number.isInteger(value) ? String(value) : value.toFixed(1);

    }



    function calculateSD(values: number[]): number {

        if (values.length < 2) return 0;

        const mean     = values.reduce((a, b) => a + b, 0) / values.length;

        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);

        return Math.sqrt(variance);

    }



    function shuffleArray<T>(array: T[]): void {

        for (let i = array.length - 1; i > 0; i--) {

            const buf = new Uint32Array(1);

            crypto.getRandomValues(buf);

            const j = buf[0] % (i + 1);

            [array[i], array[j]] = [array[j], array[i]];

        }

    }



    function noMaxConsecutiveNoGo(arr: Stimulus[], max: number): boolean {

        let count = 0;

        for (const s of arr) {

            count = s.type === 'no-go' ? count + 1 : 0;

            if (count > max) return false;

        }

        return true;

    }



    function generateStimuli(goCount: number, noGoCount: number): Stimulus[] {

        const arr: Stimulus[] = [

            ...Array.from({ length: goCount },   () => ({ type: 'go'    as const, color: '#22C55E' })),

            ...Array.from({ length: noGoCount }, () => ({ type: 'no-go' as const, color: '#EF4444' }))

        ];

        let attempts = 0;

        do {

            shuffleArray(arr);

            attempts++;

        } while (!noMaxConsecutiveNoGo(arr, 4) && attempts < 1000);

        return arr;

    }



    function clearTimers() {

        if (rafHandle !== null)  { cancelAnimationFrame(rafHandle); rafHandle = null; }

        if (stimulusTimeout)     { clearTimeout(stimulusTimeout);   stimulusTimeout = null; }

        if (feedbackTimeout)     { clearTimeout(feedbackTimeout);   feedbackTimeout = null; }

    }



    // ─── Game flow ────────────────────────────────────────────────────────────

    function startGame() {

        onIniciar?.();

        clearTimers();

        practiceStimuli = generateStimuli(4, 1);

        trials          = [];

        trialIndex      = 0;

        clicksFuera     = 0;

        isPracticePhase = true;

        scheduleNextTrial();

    }



    function startRealGame() {

        clearTimers();

        stimuli         = generateStimuli(80, 20);

        trialIndex      = 0;

        isPracticePhase = false;

        scheduleNextTrial();

    }



    function scheduleNextTrial() {

        clearTimers();

        const limit = isPracticePhase ? PRACTICE_COUNT : TOTAL_TRIALS;



        if (trialIndex >= limit) {

            gameState = isPracticePhase ? 'practice-complete' : (modoEvaluacion ? gameState : 'results');

            if (!isPracticePhase) guardarResultados();

            return;

        }



        currentStimulus = (isPracticePhase ? practiceStimuli : stimuli)[trialIndex];



        const isiDuration = Math.random() * 1500 + 1000;

        const isiStart    = performance.now();

        gameState = 'waiting';



        function waitLoop() {

            const elapsed = performance.now() - isiStart;

            if (elapsed >= isiDuration) {

                currentISI = elapsed;

                gameState  = 'stimulus';

                // Doble RAF: el primero espera el DOM update (tick),

                // el segundo espera el paint real del estímulo.

                // startTime se registra cuando el círculo ya es visible.

                tick().then(() => {

                    requestAnimationFrame(() => {

                        requestAnimationFrame(() => {

                            startTime = performance.now();

                            const rtLimit = 1000 + Math.random() * 500;

                            stimulusTimeout = setTimeout(() => endTrial(false, false, 0), rtLimit);

                        });

                    });

                });

            } else {

                rafHandle = requestAnimationFrame(waitLoop);

            }

        }

        rafHandle = requestAnimationFrame(waitLoop);

    }



    function handleClick(isGoClick: boolean) {

        if (gameState !== 'stimulus') return;

        clearTimers();

        const clickTimestamp   = Date.now();

        const rt               = performance.now() - startTime;

        const anticipationError = rt < 150;

        endTrial(true, isGoClick, rt, anticipationError, clickTimestamp);

    }



    function handleOutsideClick(event: Event) {

        if (!['waiting', 'stimulus', 'feedback'].includes(gameState)) return;

        if (!(event.target as Element).closest('.stimulus')) clicksFuera++;

    }



    function endTrial(

        clicked: boolean,

        isGoClick: boolean,

        rt: number,

        anticipationError = false,

        clickTimestamp?: number

    ) {

        clearTimers();

        const isGoStimulus = currentStimulus?.type === 'go';

        const correct = !clicked

            ? !isGoStimulus

            : isGoStimulus && isGoClick && !anticipationError;



        let errorType: Trial['errorType'] = null;

        if (anticipationError)   errorType = 'anticipation';

        else if (!correct)       errorType = isGoStimulus ? 'omission' : 'commission';



        const block: 1 | 2 | 'practice' = isPracticePhase

            ? 'practice'

            : trialIndex < 50 ? 1 : 2;



        currentTrial = {

            type: currentStimulus?.type ?? 'go',

            reactionTime: clicked ? rt : undefined,

            correct,

            anticipationError,

            block,

            isi: currentISI,

            clickTimestamp,

            isPractice: isPracticePhase,

            errorType

        };

        trials.push(currentTrial);

        gameState = 'feedback';

        feedbackTimeout = setTimeout(() => { trialIndex++; scheduleNextTrial(); }, 800);

    }



    async function guardarResultados() {

        guardandoResultados = true;

        errorGuardado       = null;

        guardadoExitoso     = false;



        const { error } = await supabase.from('gonogo').insert({

            evaluacion_id:        evaluacion_id ?? null,

            precision_total:      Math.round(accuracy),

            rt_promedio:          avgGo,

            desviacion_estandar:  sdGo,

            tiempo_minimo:        minGo,

            tiempo_maximo:        maxGo,

            go_correctos:         goCorrect,

            nogo_correctos:       noGoCorrect,

            errores_omision:      omissions,

            errores_comision:     commissions,

            errores_anticipacion: anticipationErrors,

            clicks_fuera:         clicksFuera,

            promedio_bloque1:     avgFirst,

            promedio_bloque2:     avgLast

        });



        if (error) {

            console.error('Error al guardar en Supabase:', error);

            errorGuardado = 'No se pudieron guardar los resultados. Intenta de nuevo.';

        } else {

            guardadoExitoso = true;

            if (modoEvaluacion) onTerminar?.();

        }



        guardandoResultados = false;

    }



    function resetGame() {

        clearTimers();

        trials          = [];

        trialIndex      = 0;

        clicksFuera     = 0;

        isPracticePhase = false;

        gameState       = 'start';

    }



    // ─── Reports ──────────────────────────────────────────────────────────────

    async function downloadReportPdf() {

        if (typeof window === 'undefined') return;

        const { jsPDF }   = await import('jspdf');

        const html2canvas = (await import('html2canvas')).default;

        const resultsElement = document.getElementById('results-section');

        if (!resultsElement) return;



        const canvas     = await html2canvas(resultsElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });

        const imgData    = canvas.toDataURL('image/png');

        const doc        = new jsPDF({ unit: 'pt', format: 'a4' });

        const pageWidth  = doc.internal.pageSize.getWidth();

        const pageHeight = doc.internal.pageSize.getHeight();



        // ── Página 1: captura visual de resultados ──────────────────────────

        doc.setFontSize(18);

        doc.text('Reporte Go/No-Go', pageWidth / 2, 32, { align: 'center' });



        const imgWidth      = pageWidth - 40;

        const imgHeightFull = (canvas.height * imgWidth) / canvas.width;

        const maxImgH       = pageHeight - 55; // espacio disponible bajo el título



        if (imgHeightFull <= maxImgH) {

            // Cabe en una sola página

            doc.addImage(imgData, 'PNG', 20, 45, imgWidth, imgHeightFull);

        } else {

            // Imagen muy larga: dividirla en franjas de página

            const pxPerPt   = canvas.width / imgWidth;

            const sliceH_pt = pageHeight - 55;

            const sliceH_px = Math.round(sliceH_pt * pxPerPt);

            let   offsetY   = 0;



            while (offsetY < canvas.height) {

                const remaining = canvas.height - offsetY;

                const thisSlice = Math.min(sliceH_px, remaining);



                // Crear canvas temporal con la franja

                const tmp    = document.createElement('canvas');

                tmp.width    = canvas.width;

                tmp.height   = thisSlice;

                tmp.getContext('2d')!.drawImage(canvas, 0, -offsetY);

                const sliceData    = tmp.toDataURL('image/png');

                const sliceH_ptOut = (thisSlice * imgWidth) / canvas.width;



                doc.addImage(sliceData, 'PNG', 20, 45, imgWidth, sliceH_ptOut);

                offsetY += thisSlice;



                if (offsetY < canvas.height) doc.addPage();

            }

        }



        // ── Última página: resumen numérico ──────────────────────────────────

        doc.addPage();

        doc.setFontSize(14);

        doc.text('Resumen de Resultados', 20, 40);

        doc.setFontSize(11);



        const resumen = [

            `Generado el:              ${new Date().toLocaleString()}`,

            `Precisión:                ${fmtNumber(accuracy)} %`,

            `Tiempo Promedio GO:       ${fmtNumber(avgGo)} ms`,

            `Desviación Estándar GO:   ${fmtNumber(sdGo)} ms`,

            `Tiempo Más Rápido:        ${fmtNumber(minGo)} ms`,

            `Tiempo Más Lento:         ${fmtNumber(maxGo)} ms`,

            `GO Correctos:             ${goCorrect} / ${goTrials.length}`,

            `NO GO Correctos:          ${noGoCorrect} / ${noGoTrials.length}`,

            `Errores de Omisión:       ${omissions}`,

            `Errores de Comisión:      ${commissions}`,

            `Errores de Anticipación:  ${anticipationErrors}`,

            `Promedio Bloque 1 (1-50):   ${fmtNumber(avgFirst)} ms`,

            `Promedio Bloque 2 (51-100): ${fmtNumber(avgLast)} ms`,

        ];

        resumen.forEach((line, i) => doc.text(line, 20, 68 + i * 22));



        // ── Guardar / compartir ───────────────────────────────────────────────

        if (Capacitor.isNativePlatform()) {

            const base64 = doc.output('datauristring').split(',')[1];

            try {

                // Directory.Cache no requiere permisos de almacenamiento en Android

                const result = await Filesystem.writeFile({

                    path:      'reporte-go-no-go.pdf',

                    data:      base64,

                    directory: Directory.Cache

                });

                await Share.share({

                    title:       'Reporte Go/No-Go',

                    files:       [result.uri],

                    dialogTitle: 'Compartir reporte'

                });

            } catch (err) {

                console.error('Error al compartir PDF:', err);

                alert('No se pudo compartir el PDF. Revisa que la app tenga permisos de almacenamiento.');

            }

        } else {

            doc.save('reporte-go-no-go.pdf');

        }

    }



    async function downloadReportExcel() {

        if (typeof window === 'undefined') return;



        const summaryData = [

            ['Métrica', 'Valor'],

            ['Fecha de Generación',              new Date().toLocaleString()],

            ['Precisión',                         fmtNumber(accuracy)  + '%'],

            ['Tiempo Promedio GO',                fmtNumber(avgGo)    + ' ms'],

            ['Desviación Estándar GO (muestral)', fmtNumber(sdGo)     + ' ms'],

            ['Tiempo Más Rápido',                 fmtNumber(minGo)    + ' ms'],

            ['Tiempo Más Lento',                  fmtNumber(maxGo)    + ' ms'],

            ['GO Correctos',                      goCorrect  + '/' + goTrials.length],

            ['NO GO Correctos',                   noGoCorrect + '/' + noGoTrials.length],

            ['Errores de Omisión',                omissions],

            ['Errores de Comisión',               commissions],

            ['Errores de Anticipación',           anticipationErrors],

            ['Clicks Fuera del Estímulo',         clicksFuera],

            ['Promedio Bloque 1 (1-50)',           fmtNumber(avgFirst) + ' ms'],

            ['Promedio Bloque 2 (51-100)',         fmtNumber(avgLast)  + ' ms']

        ];



        const trialsData: string[][] = [[

            'Ensayo', 'Tipo', 'Bloque', 'ISI (ms)', 'Correcto',

            'Tiempo Reacción (ms)', 'Timestamp Click (ms)',

            'Error Anticipación', 'Tipo de Error', 'Es Práctica'

        ]];

        trials.forEach((trial, i) => {

            trialsData.push([

                String(i + 1),

                trial.type === 'go' ? 'GO' : 'NO GO',

                String(trial.block),

                trial.isi.toFixed(1),

                trial.correct ? 'Sí' : 'No',

                trial.reactionTime != null ? trial.reactionTime.toFixed(2) : 'N/A',

                trial.clickTimestamp != null ? String(trial.clickTimestamp) : 'N/A',

                trial.anticipationError ? 'Sí' : 'No',

                trial.errorType === 'omission'    ? 'Omisión'

                    : trial.errorType === 'commission'  ? 'Comisión'

                    : trial.errorType === 'anticipation' ? 'Anticipación'

                    : 'Ninguno',

                trial.isPractice ? 'Sí' : 'No'

            ]);

        });



        const wb    = XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trialsData),  'Ensayos Detallados');

        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

        const blob  = new Blob([wbout], { type: 'application/octet-stream' });



        if (Capacitor.isNativePlatform()) {

            const base64 = await blobToBase64(blob);

            try {

                const result = await Filesystem.writeFile({ path: 'reporte-go-no-go.xlsx', data: base64, directory: Directory.Documents });

                await Share.share({ title: 'Reporte Go/No-Go Excel', files: [result.uri], dialogTitle: 'Compartir reporte Excel' });

            } catch (err) {

                console.error('Error al guardar/compartir Excel:', err);

                alert('Error al guardar o compartir el Excel.');

            }

        } else {

            const url = URL.createObjectURL(blob);

            const a   = document.createElement('a');

            a.href    = url;

            a.download = 'reporte-go-no-go.xlsx';

            document.body.appendChild(a);

            a.click();

            document.body.removeChild(a);

            URL.revokeObjectURL(url);

        }

    }



    function blobToBase64(blob: Blob): Promise<string> {

        return new Promise((resolve, reject) => {

            const reader    = new FileReader();

            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);

            reader.onerror   = reject;

            reader.readAsDataURL(blob);

        });

    }

</script>



<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->

<main

    class="game-container"

    class:start-theme={gameState === 'start'}

    onpointerdown={handleOutsideClick}

    onkeydown={() => {}}

    role="application"

>



    {#if gameState === 'start'}

        <div class="intro-card" in:fly={{ y: 20, duration: 500 }}>

            <h2 class="intro-title">Go / No-Go</h2>
            <p class="intro-subtitle">Reacciona solo cuando corresponda</p>

            <div class="intro-steps">

                <div class="intro-step">
                    <div class="circle-go-instr"></div>
                    <div class="step-text">
                        <strong class="go-label">👆 Toca</strong>
                        <span>Cuando veas el círculo <strong style="color:#16a34a">verde</strong>, toca tan rápido como puedas</span>
                    </div>
                </div>

                <div class="step-arrow">↓</div>

                <div class="intro-step">
                    <div class="circle-nogo-instr"></div>
                    <div class="step-text">
                        <strong class="nogo-label">✋ No toques</strong>
                        <span>Cuando veas el círculo <strong style="color:#dc2626">rojo</strong>, quédate quieto</span>
                    </div>
                </div>

                <div class="step-arrow">↓</div>

                <div class="intro-step">
                    <div class="step-icon" style="background:#fef9c3">⚡</div>
                    <div class="step-text">
                        <strong>Práctica primero</strong>
                        <span>{PRACTICE_COUNT} ensayos de práctica antes de comenzar</span>
                    </div>
                </div>

            </div>

            <button class="btn-primary-intro" onclick={startGame}>Comenzar Prueba</button>
            {#if onVolver}
                <button class="btn-outline-intro" onclick={onVolver}>← Volver al Dashboard</button>
            {/if}

        </div>



    {:else if gameState === 'waiting'}

        <div class="game-area">

            <div class="fixation">+</div>

        </div>



    {:else if gameState === 'stimulus'}

        <div class="game-area">

            <div

                class="stimulus"

                style="background-color: {currentStimulus!.color}"

                onpointerdown={(e) => { e.stopPropagation(); handleClick(currentStimulus!.type === 'go'); }}

                onkeydown={(e: KeyboardEvent) => {

                    if (e.key === 'Enter' || e.key === ' ') {

                        e.stopPropagation();

                        handleClick(currentStimulus!.type === 'go');

                    }

                }}

                role="button"

                tabindex="0">

            </div>

        </div>



    {:else if gameState === 'feedback'}

        <div class="game-area">

            {#if currentTrial}

                <div class="feedback {currentTrial.correct ? 'feedback--correct' : 'feedback--incorrect'}">

                    {currentTrial.correct ? '✓' : '✗'}

                </div>

            {/if}

        </div>



    {:else if gameState === 'practice-complete'}

        <div class="interlude-wrap">

            <div class="start-card">

                <h2>¡Práctica completada!</h2>

                <p>¡Bien! Ya conoces la mecánica. Ahora sí comienza la prueba real.</p>

            </div>

            <button class="start-button" onclick={startRealGame}>Comenzar Test Real</button>

        </div>



    {:else if gameState === 'paused'}

        <div class="interlude-wrap">

            <div class="start-card">

                <h2>Prueba pausada</h2>

                <p>Saliste de la pestaña durante un ensayo. El ensayo actual se reiniciará al continuar para no contaminar los tiempos de reacción.</p>

            </div>

            <button class="start-button" onclick={scheduleNextTrial}>Continuar</button>

        </div>



    {:else if gameState === 'results'}

        <div id="results-section">

            <h2>Resultados</h2>

            {#if guardandoResultados}

                <p class="guardado-estado">Guardando resultados…</p>

            {:else if errorGuardado}

                <p class="guardado-error">{errorGuardado}

                    <button onclick={guardarResultados}>Reintentar</button>

                </p>

            {:else if guardadoExitoso}

                <p class="guardado-ok">Resultados guardados correctamente.</p>

            {/if}

            <div class="results-grid">

                <div class="card card--precision">

                    <h3>Precisión</h3>

                    <p class="big">{fmtNumber(accuracy)}%</p>

                    <p class="cdesc">{totalCorrect} de {TOTAL_TRIALS} ensayos correctos</p>

                </div>

                <div class="card card--avg">

                    <h3>Tiempo Promedio</h3>

                    <p class="big">{fmtNumber(avgGo)} ms</p>

                    <p class="cdesc">Velocidad de respuesta en estímulos GO</p>

                </div>

                <div class="card card--sd">

                    <h3>Desviación Estándar</h3>

                    <p class="big">{fmtNumber(sdGo)} ms</p>

                    <p class="cdesc">Variabilidad en tiempos de reacción GO</p>

                </div>

                <div class="card card--fast">

                    <h4>Más Rápida</h4>

                    <p class="big">{fmtNumber(minGo)} ms</p>

                    <p class="cdesc">Tiempo de reacción mínimo registrado</p>

                </div>

                <div class="card card--slow">

                    <h4>Más Lenta</h4>

                    <p class="big">{fmtNumber(maxGo)} ms</p>

                    <p class="cdesc">Tiempo de reacción máximo registrado</p>

                </div>

                <div class="card card--go">

                    <h4>GO correctos</h4>

                    <p class="big">{goCorrect}/{goTrials.length}</p>

                    <p class="cdesc">Respuestas correctas a círculos verdes</p>

                </div>

                <div class="card card--nogo">

                    <h4>NO GO correctos</h4>

                    <p class="big">{noGoCorrect}/{noGoTrials.length}</p>

                    <p class="cdesc">Inhibiciones exitosas ante círculos rojos</p>

                </div>

                <div class="card card--out">

                    <h4>Clicks fuera</h4>

                    <p class="big">{clicksFuera}</p>

                    <p class="cdesc">Clicks fuera del área del estímulo</p>

                </div>

                <div class="card card--anticipation">

                    <h4>Anticipación</h4>

                    <p class="big">{anticipationErrors}</p>

                    <p class="cdesc">Respuestas en menos de 150 ms</p>

                </div>

            </div>



            <div class="analysis">

                <h3>Análisis de Errores</h3>

                <div class="analysis-row">

                    <div class="card card--omit">

                        <h4>Errores de Omisión</h4>

                        <p class="big">{omissions}</p>

                        <p class="cdesc">Sin respuesta ante círculos verdes</p>

                    </div>

                    <div class="card card--comm">

                        <h4>Errores de Comisión</h4>

                        <p class="big">{commissions}</p>

                        <p class="cdesc">Respuesta incorrecta ante círculos rojos</p>

                    </div>

                </div>

                <h3>Análisis de Fatiga</h3>

                <div class="analysis-row">

                    <div class="card card--fatigue">

                        <h4>Promedio Bloque 1 (1–50)</h4>

                        <p class="big">{fmtNumber(avgFirst)} ms</p>

                        <p class="cdesc">Tiempo promedio en la primera mitad</p>

                    </div>

                    <div class="card card--fatigue">

                        <h4>Promedio Bloque 2 (51–100)</h4>

                        <p class="big">{fmtNumber(avgLast)} ms</p>

                        <p class="cdesc">Tiempo promedio en la segunda mitad</p>

                    </div>

                </div>

            </div>

        </div>



        <div class="report-footer">

            <div class="btn-row">

                <button class="download-button" onclick={downloadReportPdf}>Descargar PDF</button>

                <button class="download-button" onclick={downloadReportExcel}>Descargar Excel</button>

            </div>

            <div class="btn-row">

                <button class="btn-secondary" onclick={resetGame}>Reiniciar</button>

                {#if onVolver}

                    <button class="btn-secondary" onclick={onVolver}>← Volver al Dashboard</button>

                {/if}

                {#if onTerminar}

                    <button class="start-button" onclick={onTerminar}>Continuar evaluación →</button>

                {/if}

            </div>

        </div>

    {/if}



</main>



<style>

:global(html), :global(body) {

    padding: 0; margin: 0; box-sizing: border-box; overflow-x: hidden;

}

:global(*), :global(*::before), :global(*::after) { box-sizing: inherit; }



.game-container {

    display: flex; flex-direction: column; align-items: center; justify-content: center;

    min-height: 100vh; padding: 40px 16px;

    font-family: Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

    background: #f0f4f8;

    user-select: none; -webkit-user-select: none;

}

.start-theme { background: #f0f4f8; }



/* ── Start Screen ────────────────────────────────────────────────────────── */

.intro-card {
    background: white; border-radius: 2rem;
    box-shadow: 0 10px 40px rgba(0,0,0,0.08);
    padding: 2rem 1.75rem; width: min(400px, 100%);
    display: flex; flex-direction: column; align-items: stretch;
    gap: 0;
}

.intro-title {
    font-size: 1.8rem; font-weight: 900; color: #1e293b;
    margin: 0 0 4px; text-align: center;
}

.intro-subtitle {
    color: #64748b; font-size: 1rem; text-align: center;
    margin: 0 0 1.5rem; font-weight: 500;
}

.intro-steps {
    background: #f8fafc; border-radius: 1.2rem;
    padding: 1.2rem 1rem; margin-bottom: 1.5rem;
    display: flex; flex-direction: column; gap: 0;
}

.intro-step {
    display: flex; align-items: center; gap: 14px;
}

.step-icon {
    width: 44px; height: 44px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.3rem; flex-shrink: 0;
}

.step-text {
    display: flex; flex-direction: column; gap: 2px;
}

.step-text strong {
    font-size: 0.95rem; font-weight: 700; color: #1e293b;
}

.step-text span {
    font-size: 0.82rem; color: #64748b;
}

.step-arrow {
    text-align: center; color: #cbd5e1; font-size: 1rem;
    padding: 6px 0;
}

.circle-go-instr {
    width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
    background: radial-gradient(circle, #4ade80, #16a34a);
}

.circle-nogo-instr {
    width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
    background: radial-gradient(circle, #f87171, #dc2626);
}

.go-label   { color: #16a34a !important; }
.nogo-label { color: #dc2626 !important; }

.btn-primary-intro {
    background: #1e293b; color: white; border: none;
    padding: 1rem; border-radius: 1rem; width: 100%;
    font-weight: 700; font-size: 1rem; cursor: pointer;
    margin-bottom: 10px;
}

.btn-outline-intro {
    background: transparent; border: 2px solid #e2e8f0;
    padding: 0.8rem; border-radius: 50px; cursor: pointer;
    width: 100%; font-weight: 600; color: #64748b; font-size: 0.95rem;
}



/* ── Game Area ────────────────────────────────────────────────────────────── */

.game-area {

    display: flex; align-items: center; justify-content: center;

    min-height: 100vh; width: 100%;

}

.fixation {

    font-size: 4rem; font-weight: 700; color: #0f172a;

    line-height: 1; user-select: none;

}

.stimulus {

    width: 160px; height: 160px; border-radius: 50%;

    cursor: pointer; touch-action: manipulation;

    box-shadow: 0 0 40px rgba(0,0,0,0.2);

    transition: transform 0.1s ease;

}

.stimulus:active { transform: scale(0.93); }

.feedback {

    width: 100px; height: 100px; border-radius: 50%;

    display: flex; align-items: center; justify-content: center;

    font-size: 3rem; font-weight: 800; color: white;

}

.feedback--correct  { background: linear-gradient(135deg, #16a34a, #15803d); box-shadow: 0 0 32px rgba(22,163,74,0.4); }

.feedback--incorrect { background: linear-gradient(135deg, #dc2626, #b91c1c); box-shadow: 0 0 32px rgba(220,38,38,0.4); }



/* ── Interlude / Paused ───────────────────────────────────────────────────── */

.interlude-wrap {

    display: flex; flex-direction: column; align-items: center; gap: 24px;

    min-height: 100vh; justify-content: center; padding: 40px 20px;

}

.start-card {

    background: rgba(255,255,255,0.97); border-radius: 20px;

    box-shadow: 0 20px 40px rgba(15,23,42,0.12); padding: 40px 32px;

    max-width: 420px; width: 100%; text-align: center;

}

.start-card h2 { margin: 0 0 12px; font-size: 1.5rem; color: #0f172a; }

.start-card p  { color: rgba(15,23,42,0.65); line-height: 1.6; margin: 0; }

.start-button {

    padding: 14px 40px; font-size: 1rem; font-weight: 700;

    border-radius: 999px; border: none;

    background: linear-gradient(135deg, #6366f1, #8b5cf6);

    color: white; cursor: pointer;

    box-shadow: 0 10px 24px rgba(99,102,241,0.35);

    transition: transform 0.2s ease, box-shadow 0.2s ease;

}

.start-button:hover { transform: translateY(-2px); box-shadow: 0 14px 32px rgba(99,102,241,0.5); }



/* ── Results Section ─────────────────────────────────────────────────────── */

#results-section {

    width: 100%; max-width: 700px; padding: 32px 16px;

    display: flex; flex-direction: column; gap: 24px;

}

#results-section h2 {

    font-size: 1.8rem; font-weight: 800; color: #0f172a; margin: 0; text-align: center;

}

#results-section h3 { font-size: 1.1rem; font-weight: 700; color: #0f172a; margin: 0 0 12px; }

.guardado-estado { color: #6366f1; font-size: 0.9rem; text-align: center; margin: 0; }

.guardado-error  { color: #dc2626; font-size: 0.9rem; text-align: center; margin: 0; }

.guardado-ok     { color: #16a34a; font-size: 0.9rem; text-align: center; margin: 0; }

.guardado-error button {

    margin-left: 8px; padding: 4px 12px; border-radius: 6px;

    border: 1px solid #dc2626; background: transparent; color: #dc2626;

    cursor: pointer; font-size: 0.85rem;

}



/* ── Cards Grid ──────────────────────────────────────────────────────────── */

.results-grid {

    display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));

    gap: 14px;

}

.analysis-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.analysis { display: flex; flex-direction: column; gap: 12px; }

.card {

    background: #fff; border-radius: 16px; padding: 20px 16px; text-align: center;

    box-shadow: 0 4px 16px rgba(15,23,42,0.08); border-top: 4px solid #e2e8f0;

}

.card h3, .card h4 { margin: 0 0 8px; color: #475569; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }

.big  { font-size: 1.9rem; font-weight: 800; color: #0f172a; margin: 0 0 4px; }

.cdesc { font-size: 0.75rem; color: #94a3b8; margin: 0; line-height: 1.4; }

.card--precision    { border-top-color: #6366f1; }

.card--avg          { border-top-color: #0ea5e9; }

.card--sd           { border-top-color: #f59e0b; }

.card--fast         { border-top-color: #10b981; }

.card--slow         { border-top-color: #f43f5e; }

.card--go           { border-top-color: #16a34a; }

.card--nogo         { border-top-color: #dc2626; }

.card--out          { border-top-color: #94a3b8; }

.card--anticipation { border-top-color: #f97316; }

.card--omit         { border-top-color: #f59e0b; }

.card--comm         { border-top-color: #ec4899; }

.card--fatigue      { border-top-color: #8b5cf6; }



/* ── Report Footer ───────────────────────────────────────────────────────── */

.report-footer { display: flex; flex-direction: column; gap: 12px; align-items: center; }

.btn-row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }

.download-button {

    padding: 12px 28px; border-radius: 999px; border: none;

    background: linear-gradient(135deg, #0f172a, #1e293b);

    color: white; font-size: 0.9rem; font-weight: 600; cursor: pointer;

    box-shadow: 0 8px 18px rgba(15,23,42,0.2);

    transition: transform 0.15s ease, box-shadow 0.15s ease;

}

.download-button:hover { transform: translateY(-1px); box-shadow: 0 12px 24px rgba(15,23,42,0.3); }

.btn-secondary {

    padding: 12px 28px; border-radius: 999px;

    border: 2px solid #e2e8f0; background: transparent;

    color: #64748b; font-size: 0.9rem; cursor: pointer;

    transition: background 0.15s ease;

}

.btn-secondary:hover { background: #f8fafc; }



@media (max-width: 480px) {

    .analysis-row { grid-template-columns: 1fr; }

    .results-grid { grid-template-columns: 1fr 1fr; }

}

</style>