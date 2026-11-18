import test from 'node:test';
import assert from 'node:assert/strict';
import FormatoService, { validateFormato, quitarToken, nombreArchivo } from '../services/FormatoService.js';

const config = { get: async () => ({ endpoint: 'https://x.test/api/', token: 'S3CR3T/=' }) };
function fixture(respond) {
    const calls = [];
    const http = { request: async opts => { calls.push(opts); return respond(opts); } };
    return { service: new FormatoService('636939444', { http, config }), calls };
}

test('validateFormato: solo valores conocidos; PDF por omisión', () => {
    assert.deepEqual(validateFormato({}), { salida: 'pdf' });
    assert.deepEqual(validateFormato({ formato: 'carta', idioma: 'en', salida: 'html', descargar: '1', token: 'x', otro: 1 }), { formato: 'carta', idioma: 'en', salida: 'html', descargar: '1' });
    for (const q of [{ formato: 'resumen' }, { idioma: 'fr' }, { salida: 'json' }, { formato: ['carta'] }]) assert.throws(() => validateFormato(q), /inválido/, JSON.stringify(q));
    assert.equal(nombreArchivo('9', { formato: 'detallado', salida: 'pdf' }), 'Prebill-9-detallado.pdf');
});

test('PDF: una sola petición GET a /formatos/prebill/:id, binaria y con límite de tiempo', async () => {
    const pdf = Buffer.from('%PDF-1.7 ...');
    const { service, calls } = fixture(() => ({ headers: { 'content-type': 'application/pdf' }, data: pdf }));
    const r = await service.prebill('9', { formato: 'carta', descargar: '1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'get');
    assert.equal(calls[0].url, 'https://x.test/api/formatos/prebill/9');
    assert.deepEqual(calls[0].params, { formato: 'carta', salida: 'pdf', descargar: '1', token: 'S3CR3T/=' });
    assert.equal(calls[0].responseType, 'arraybuffer');
    assert.ok(calls[0].timeout <= 25000);
    assert.equal(r.contentType, 'application/pdf');
    assert.equal(r.disposition, 'attachment; filename="Prebill-9-carta.pdf"');
    assert.deepEqual(r.body, pdf);
});

test('HTML: nunca lleva el token (ni codificado) al navegador', async () => {
    const html = '<a href="/api/formatos/prebill/9?salida=pdf&token=S3CR3T/=">PDF</a><a href="?token=S3CR3T%2F%3D">x</a>';
    const { service } = fixture(() => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, data: Buffer.from(html) }));
    const r = await service.prebill('9', { salida: 'html' });
    assert.equal(r.body.toString().includes('S3CR3T'), false);
    assert.equal(r.body.toString().includes('<a'), false); // los enlaces de la barra se quitan
    assert.equal(quitarToken('a=tok&b=tok', 'tok'), 'a=&b=');
    assert.equal(quitarToken('<div class="barra"><a href="/x?token=">Formatos</a><button onclick="window.print()">Imprimir</button><a href="/y?salida=pdf&amp;token=" target="_blank">PDF</a></div><a href="https://a.mx">ok</a>', 'zz'),
        '<div class="barra"><button onclick="window.print()">Imprimir</button></div><a href="https://a.mx">ok</a>');
});

test('errores: mensajes claros, sin el token', async () => {
    const err = (status, body) => Object.assign(new Error('Request failed https://x.test?token=S3CR3T/='), { response: { status, data: Buffer.from(JSON.stringify(body)) } });
    let { service } = fixture(() => { throw err(404, { error: 'Prebill 99 no existe' }); });
    await assert.rejects(service.prebill('99', {}), e => e.status === 404 && /no existe/.test(e.message) && !/S3CR3T/.test(e.message));
    ({ service } = fixture(() => { throw err(503, { error: 'PDF no disponible' }); }));
    await assert.rejects(service.prebill('9', {}), e => e.status === 503 && /versión para imprimir/.test(e.message));
    ({ service } = fixture(() => { throw Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' }); }));
    await assert.rejects(service.prebill('9', {}), e => e.status === 504);
    ({ service } = fixture(() => { throw err(500, {}); }));
    await assert.rejects(service.prebill('9', {}), e => e.status === 502 && !/S3CR3T/.test(e.message));
    ({ service } = fixture(() => ({ headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') })));
    await assert.rejects(service.prebill('9', {}), e => e.status === 502 && /inesperado/.test(e.message));
    ({ service } = fixture(() => ({})));
    await assert.rejects(service.prebill('x', {}), e => e.status === 400);
    const sinConexion = new FormatoService('636939444', { http: { request: async () => ({}) }, config: { get: async () => ({}) } });
    await assert.rejects(sinConexion.prebill('9', {}), e => e.status === 503 && e.stage === 'connection');
});
