<script lang="ts">
	import GoNoGo    from './GoNoGo.svelte';
	import Secuencia from './Secuencia.svelte';
	import Stopper   from './Stopper.svelte';
	import { supabase } from './supabaseClient';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share } from '@capacitor/share';

	let { onVolver = undefined as (() => void) | undefined } = $props();

	type Fase = 'gonogo' | 'secuencia' | 'stroop' | 'fin';

	let fase         = $state<Fase>('gonogo');
	let evaluacionId = $state<number | undefined>(undefined);

	// ─── Estado del reporte IA ────────────────────────────────────────────────
	let generandoReporte = $state(false);
	let errorReporte     = $state<string | null>(null);

	// Registro en BD solo cuando el usuario inicia el primer test.
	async function crearRegistroEvaluacion() {
		const { data, error } = await supabase
			.from('evaluaciones')
			.insert({ fecha_inicio: new Date().toISOString() })
			.select('id')
			.single();
		if (error || !data) {
			console.error('Error al crear registro de evaluación:', error);
		} else {
			evaluacionId = data.id;
		}
	}

	async function marcarCompletada() {
		if (evaluacionId !== undefined) {
			await supabase
				.from('evaluaciones')
				.update({ fecha_fin: new Date().toISOString(), completada: true })
				.eq('id', evaluacionId);
		}
		fase = 'fin';
	}

	// ─── Reporte con IA (Gemini) ──────────────────────────────────────────────
	async function generarReporteIA() {
		if (!evaluacionId) return;
		generandoReporte = true;
		errorReporte     = null;

		try {
			// 1. Obtener resultados de las 3 pruebas desde Supabase
			const [resGonogo, resSecuencia, resStroop] = await Promise.all([
				supabase.from('gonogo').select('*').eq('evaluacion_id', evaluacionId).single(),
				supabase.from('secuencia').select('*').eq('evaluacion_id', evaluacionId).single(),
				supabase.from('resultados_stroop').select('*').eq('evaluacion_id', evaluacionId).single(),
			]);

			if (resGonogo.error || resSecuencia.error || resStroop.error) {
				throw new Error('No se pudieron obtener los resultados de la evaluación.');
			}

			const g = resGonogo.data;
			const s = resSecuencia.data;
			const t = resStroop.data;

			const fmt = (v: number | null | undefined) =>
				v === null || v === undefined ? 'No disponible' : Number.isInteger(v) ? String(v) : Number(v).toFixed(1);

			// 2. Construir prompt
			const prompt = `Eres un asistente especializado en neuropsicología clínica. Genera un reporte descriptivo profesional en español a partir de los siguientes resultados de una batería neuropsicológica.

INSTRUCCIONES ESTRICTAS:
- Usa lenguaje técnico-profesional apropiado para reportes neuropsicológicos.
- Describe e interpreta los resultados de forma objetiva y descriptiva.
- NO emitas diagnósticos clínicos, no uses términos como "el paciente padece" o "se diagnostica".
- Menciona rangos normativos de referencia cuando sea relevante (adultos sanos, 18-65 años).
- El reporte es de apoyo descriptivo, no reemplaza la evaluación clínica presencial.
- Responde ÚNICAMENTE con el reporte, sin comentarios adicionales fuera del formato.

DATOS DE LA EVALUACIÓN (${new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}):

=== PRUEBA 1: GO/NO-GO — Control Inhibitorio ===
Precisión total: ${fmt(g.precision_total)}%
Tiempo de reacción promedio (GO): ${fmt(g.rt_promedio)} ms | DE: ${fmt(g.desviacion_estandar)} ms
TR mínimo: ${fmt(g.tiempo_minimo)} ms | TR máximo: ${fmt(g.tiempo_maximo)} ms
Ensayos GO correctos: ${fmt(g.go_correctos)}/80 | NO-GO correctos: ${fmt(g.nogo_correctos)}/20
Errores de omisión: ${fmt(g.errores_omision)} | Errores de comisión: ${fmt(g.errores_comision)}
Errores de anticipación (<200 ms): ${fmt(g.errores_anticipacion)}
TR promedio bloque 1 (ensayos 1-50): ${fmt(g.promedio_bloque1)} ms
TR promedio bloque 2 (ensayos 51-100): ${fmt(g.promedio_bloque2)} ms

=== PRUEBA 2: MEMORIA VISOESPACIAL — Secuencia de Colores ===
Span máximo alcanzado: ${fmt(s.span_maximo)} elementos
Errores totales: ${fmt(s.errores_totales)}
Latencia primera respuesta promedio (FRL): ${fmt(s.frl_promedio)} ms | DE: ${fmt(s.frl_sd)} ms
Intervalo inter-respuesta promedio (IRI): ${fmt(s.iri_promedio)} ms | DE: ${fmt(s.iri_sd)} ms
Total respuestas registradas: ${fmt(s.total_respuestas)}

=== PRUEBA 3: TEST DE STROOP — Atención Selectiva e Inhibición Cognitiva ===
Aciertos totales: ${fmt(t.aciertos_totales)}/40
TR promedio congruente: ${fmt(t.media_congruente_ms)} ms | DE: ${fmt(t.rt_congruente_sd)} ms
TR promedio incongruente: ${fmt(t.media_incongruente_ms)} ms | DE: ${fmt(t.rt_incongruente_sd)} ms
Índice de interferencia Stroop: ${fmt(t.indice_interferencia_ms)} ms (clasificación: ${t.estado_interferencia ?? 'No disponible'})
Aciertos congruentes: ${fmt(t.aciertos_congruente)}/20 | Aciertos incongruentes: ${fmt(t.aciertos_incongruente)}/20
Errores congruentes: ${fmt(t.errores_congruente)} | Errores incongruentes: ${fmt(t.errores_incongruente)}
Anticipaciones (<200 ms): ${fmt(t.anticipaciones)}

FORMATO DE RESPUESTA (respeta exactamente esta estructura, sin markdown con asteriscos ni símbolos especiales):

REPORTE DE EVALUACIÓN NEUROPSICOLÓGICA
Fecha: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

1. CONTROL INHIBITORIO - Prueba Go/No-Go
[Descripción del desempeño en 3-4 párrafos. Interpreta precisión, tiempos de reacción, tipos de errores y comparación entre bloques.]

2. MEMORIA VISOESPACIAL - Secuencia de Colores
[Descripción en 3-4 párrafos. Interpreta el span, latencia de primera respuesta y velocidad de ejecución.]

3. ATENCIÓN SELECTIVA - Test de Stroop
[Descripción en 3-4 párrafos. Interpreta el efecto de interferencia, precisión diferencial y velocidad de respuesta.]

4. RESUMEN INTEGRADO
[2-3 párrafos que integren los hallazgos de las tres pruebas y describan el perfil cognitivo general de forma coherente.]

NOTA ACLARATORIA
Este reporte ha sido generado de forma automatizada con apoyo de inteligencia artificial como herramienta descriptiva. No constituye diagnóstico clínico ni reemplaza la evaluación por un profesional de neuropsicología.`;

			// 3. Llamar a Gemini API
			const apiKey = 'AIzaSyC2C6td8dZNYGUpWr1_j-UBu0xnSsw_2Rc';
			const resp = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
					})
				}
			);

			if (!resp.ok) throw new Error(`Error en la API de Gemini: ${resp.status}`);

			const json = await resp.json();
			const texto: string = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
			if (!texto) throw new Error('La IA no devolvió contenido.');

			// 4. Generar PDF
			await exportarPDFIA(texto);

		} catch (err: unknown) {
			console.error(err);
			errorReporte = err instanceof Error ? err.message : 'Error al generar el reporte.';
		} finally {
			generandoReporte = false;
		}
	}

	async function exportarPDFIA(texto: string) {
		const { jsPDF } = await import('jspdf');
		const doc = new jsPDF({ unit: 'pt', format: 'a4' });

		const pageW  = doc.internal.pageSize.getWidth();
		const pageH  = doc.internal.pageSize.getHeight();
		const margin = 50;
		const maxW   = pageW - margin * 2;
		let   y      = margin;

		function checkPage(needed = 20) {
			if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
		}

		function addText(txt: string, size: number, style: 'normal' | 'bold', color: [number,number,number], lineH: number) {
			doc.setFontSize(size);
			doc.setFont('helvetica', style);
			doc.setTextColor(...color);
			const lines = doc.splitTextToSize(txt, maxW) as string[];
			for (const line of lines) {
				checkPage(lineH);
				doc.text(line, margin, y);
				y += lineH;
			}
		}

		// Portada / encabezado
		doc.setFillColor(15, 23, 42);
		doc.rect(0, 0, pageW, 90, 'F');
		doc.setFontSize(18);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(255, 255, 255);
		doc.text('REPORTE DE EVALUACIÓN NEUROPSICOLÓGICA', pageW / 2, 40, { align: 'center' });
		doc.setFontSize(11);
		doc.setFont('helvetica', 'normal');
		doc.text('Generado con apoyo de Inteligencia Artificial · Gemini', pageW / 2, 60, { align: 'center' });
		doc.text(new Date().toLocaleString('es-ES'), pageW / 2, 76, { align: 'center' });

		y = 110;

		// Parsear secciones del texto
		const secciones = texto.split(/\n(?=\d+\.\s+[A-ZÁÉÍÓÚÑ]|NOTA ACLARATORIA|REPORTE DE)/);

		for (const seccion of secciones) {
			const lineas = seccion.trim().split('\n').filter(l => l.trim());
			if (!lineas.length) continue;

			const encabezado = lineas[0].trim();

			// Detectar si es título de sección numerada
			const esTitulo = /^\d+\.\s/.test(encabezado) || encabezado.startsWith('NOTA') || encabezado.startsWith('REPORTE');

			if (esTitulo) {
				checkPage(40);
				y += 10;
				// Franja de color de sección
				doc.setFillColor(241, 245, 249);
				doc.roundedRect(margin - 8, y - 14, maxW + 16, 22, 4, 4, 'F');
				doc.setFontSize(12);
				doc.setFont('helvetica', 'bold');
				doc.setTextColor(15, 23, 42);
				doc.text(encabezado, margin, y);
				y += 20;
			} else {
				addText(encabezado, 11, 'normal', [30, 41, 59], 16);
			}

			// Párrafos del cuerpo
			for (let i = 1; i < lineas.length; i++) {
				const linea = lineas[i].trim();
				if (!linea) { y += 6; continue; }
				addText(linea, 10.5, 'normal', [51, 65, 85], 15);
			}
			y += 8;
		}

		// Pie de página en todas las páginas
		const totalPags = (doc as any).internal.getNumberOfPages();
		for (let p = 1; p <= totalPags; p++) {
			doc.setPage(p);
			doc.setFontSize(8);
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(148, 163, 184);
			doc.text(`Página ${p} de ${totalPags}  ·  Reporte generado con IA (Gemini) — solo descriptivo, no diagnóstico`, pageW / 2, pageH - 20, { align: 'center' });
		}

		// Exportar
		if (Capacitor.isNativePlatform()) {
			const base64 = doc.output('datauristring').split(',')[1];
			const result = await Filesystem.writeFile({
				path: 'reporte-ia-neuropsicologico.pdf',
				data: base64,
				directory: Directory.Cache
			});
			await Share.share({
				title: 'Reporte IA Neuropsicológico',
				files: [result.uri],
				dialogTitle: 'Compartir reporte'
			});
		} else {
			doc.save('Reporte_IA_Neuropsicologico.pdf');
		}
	}
</script>

{#if fase === 'gonogo'}
	<GoNoGo
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onIniciar={crearRegistroEvaluacion}
		onTerminar={() => { fase = 'secuencia'; }}
		onVolver={onVolver}
	/>

{:else if fase === 'secuencia'}
	<Secuencia
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={() => { fase = 'stroop'; }}
		onVolver={onVolver}
	/>

{:else if fase === 'stroop'}
	<Stopper
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={marcarCompletada}
		onVolver={onVolver}
	/>

{:else if fase === 'fin'}
	<div class="estado-container">
		<div class="estado-card">
			<div class="fin-icon">✓</div>
			<h1>Evaluación completada</h1>
			<p>
				El participante ha finalizado las tres pruebas neuropsicológicas:
				<strong>Go/No-Go</strong>, <strong>Memoria Visoespacial</strong>
				y <strong>Test de Stroop</strong>.
				Los resultados han sido guardados.
			</p>

			<div class="btn-stack">
				<button
					class="btn-ia"
					onclick={generarReporteIA}
					disabled={generandoReporte}
				>
					{#if generandoReporte}
						<span class="spinner"></span> Generando reporte…
					{:else}
						✦ Descargar Reporte con IA
					{/if}
				</button>

				{#if errorReporte}
					<p class="error-msg">{errorReporte}</p>
				{/if}

				{#if onVolver}
					<button class="btn-volver" onclick={onVolver}>← Volver al menú</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
:global(html), :global(body) { margin: 0; padding: 0; box-sizing: border-box; }

.estado-container {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; padding: 24px;
	font-family: Arial, system-ui, -apple-system, "Segoe UI", sans-serif;
	background: #f0f4f8;
}
.estado-card {
	background: #ffffff; border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.10); padding: 48px 32px;
	max-width: 480px; width: 100%; text-align: center;
}

.fin-icon {
	width: 72px; height: 72px; border-radius: 50%;
	background: linear-gradient(135deg, #16a34a, #15803d);
	color: white; font-size: 2.2rem; line-height: 72px;
	margin: 0 auto 20px;
}

h1 { margin: 0 0 16px; font-size: 1.9rem; color: #0f172a; }
p  { color: rgba(15,23,42,0.65); line-height: 1.6; margin-bottom: 28px; }

.btn-stack { display: flex; flex-direction: column; gap: 12px; }

.btn-ia {
	padding: 16px 32px; font-size: 1rem; border-radius: 999px;
	border: none;
	background: linear-gradient(135deg, #6366f1, #8b5cf6);
	color: white; cursor: pointer; width: 100%; font-weight: 700;
	box-shadow: 0 10px 24px rgba(99,102,241,0.35);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
	display: flex; align-items: center; justify-content: center; gap: 8px;
}
.btn-ia:hover:not(:disabled)  { transform: translateY(-2px); box-shadow: 0 14px 30px rgba(99,102,241,0.45); }
.btn-ia:active:not(:disabled) { transform: translateY(0); }
.btn-ia:disabled { opacity: 0.7; cursor: not-allowed; }

.spinner {
	width: 16px; height: 16px; border-radius: 50%;
	border: 2px solid rgba(255,255,255,0.4);
	border-top-color: white;
	animation: spin 0.7s linear infinite;
	flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.error-msg {
	color: #dc2626; font-size: 0.85rem;
	background: #fef2f2; border-radius: 10px;
	padding: 10px 14px; margin: 0;
}

.btn-volver {
	padding: 14px 32px; font-size: 1rem; border-radius: 999px;
	border: 2px solid #e2e8f0; background: transparent;
	color: #475569; cursor: pointer; width: 100%; font-weight: 600;
	transition: background 0.15s ease;
}
.btn-volver:hover { background: #f1f5f9; }
</style>
