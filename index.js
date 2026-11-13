"use strict";
// Función del proyecto Prebills (Catalyst). Todo pasa por ReportesSandbox (core/PrebillApiClient).
// FASE 1: hasta "autorizada", sin escribir en Books (ver services/PrebillService.js). Facturar y
// deshacer factura no tienen ruta a propósito.
import express from 'express';
import dotenv from 'dotenv';
import PrebillService from './services/PrebillService.js';
import { registerCatalogRoutes } from './core/catalogs.js';
import { sendError } from './core/http.js';

dotenv.config();

const app = express();
app.use(express.json());

// Cada ruta crea su servicio dentro del try: una organización inválida responde 400 en JSON.
const route = (internalMessage, handler, status = 200) => async (req, res) => {
    try { return res.status(status).json(await handler(req)); }
    catch (error) { return sendError(res, error, internalMessage); }
};
const prebills = req => new PrebillService(req.params.organizationId, { req });
const id = req => req.params.prebillId;

// ── Lecturas de una Prebill ──────────────────────────────────────────────────
app.get('/:organizationId/prebills/:prebillId', route('Error interno consultando la Prebill.', req => prebills(req).get(id(req))));
for (const what of ['disponible', 'movimientos', 'vista-factura', 'edicion']) {
    app.get(`/:organizationId/prebills/:prebillId/${what}`, route(`Error interno consultando ${what}.`, req => prebills(req).read(id(req), what)));
}

// ── Escrituras (solo ReportesSandbox) ────────────────────────────────────────
app.post('/:organizationId/prebills', route('Error interno creando la Prebill.', req => prebills(req).create(req.body), 201));
app.patch('/:organizationId/prebills/:prebillId/lineas', route('Error interno cambiando las líneas.', req => prebills(req).lineas(id(req), req.body)));
app.patch('/:organizationId/prebills/:prebillId/descuento-ajuste', route('Error interno guardando el descuento.', req => prebills(req).descuentoAjuste(id(req), req.body)));
app.patch('/:organizationId/prebills/:prebillId/idioma', route('Error interno guardando el idioma.', req => prebills(req).idioma(id(req), req.body)));
app.patch('/:organizationId/prebills/:prebillId/tipo-cambio', route('Error interno guardando el tipo de cambio.', req => prebills(req).tipoCambio(id(req), req.body)));
app.post('/:organizationId/prebills/:prebillId/estado', route('Error interno cambiando el estado.', req => prebills(req).estado(id(req), req.body)));
app.delete('/:organizationId/prebills/:prebillId', route('Error interno eliminando la Prebill.', req => prebills(req).remove(id(req))));

// ── Lecturas permitidas (GET /:organizationId/<catalogo>) y filtros que se reenvían ──
export const CATALOGS = {
    prebills: [],
    clientes: [],
    proyectos: [],
    abogados: [],
    'liberado-disponible': ['cliente_id', 'moneda'],
};
registerCatalogRoutes(app, CATALOGS);

// Sin `stage` a propósito: un 404 con `stage` significa "el registro ya no existe".
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada en prebill_services.' }));

export default app;
