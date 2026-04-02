/**
 * Phase 3 — GeoQuery tests
 */
const { Database, Model, GeoQuery, EARTH_RADIUS_KM, EARTH_RADIUS_MI } = require('../../lib/orm');

// ===================================================================
// Helpers
// ===================================================================

function memDb()
{
    return Database.connect('memory');
}

function makeModel(db, table, schema, opts = {})
{
    const M = class extends Model
    {
        static table = table;
        static schema = schema;
    };
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// Constants
// ===================================================================
describe('Geo constants', () =>
{
    it('EARTH_RADIUS_KM is 6371', () =>
    {
        expect(EARTH_RADIUS_KM).toBe(6371);
    });

    it('EARTH_RADIUS_MI is 3959', () =>
    {
        expect(EARTH_RADIUS_MI).toBe(3959);
    });
});

// ===================================================================
// Constructor Validation
// ===================================================================
describe('GeoQuery — constructor', () =>
{
    it('throws without ModelClass', () =>
    {
        expect(() => new GeoQuery(null, { latField: 'lat', lngField: 'lng' })).toThrow('requires a Model class');
    });

    it('throws without latField', () =>
    {
        expect(() => new GeoQuery(Model, { lngField: 'lng' })).toThrow('requires latField');
    });

    it('throws without lngField', () =>
    {
        expect(() => new GeoQuery(Model, { latField: 'lat' })).toThrow('requires lngField');
    });

    it('defaults unit to km', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
        expect(geo._unit).toBe('km');
    });

    it('accepts custom unit', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng', unit: 'mi' });
        expect(geo._unit).toBe('mi');
    });
});

// ===================================================================
// Haversine
// ===================================================================
describe('GeoQuery — haversine', () =>
{
    it('distance between same point is 0', () =>
    {
        expect(GeoQuery.haversine(40.7128, -74.0060, 40.7128, -74.0060)).toBe(0);
    });

    it('NY to LA is approximately 3944 km', () =>
    {
        const dist = GeoQuery.haversine(40.7128, -74.0060, 34.0522, -118.2437);
        expect(dist).toBeGreaterThan(3900);
        expect(dist).toBeLessThan(4000);
    });

    it('NY to LA in miles', () =>
    {
        const dist = GeoQuery.haversine(40.7128, -74.0060, 34.0522, -118.2437, 'mi');
        expect(dist).toBeGreaterThan(2400);
        expect(dist).toBeLessThan(2500);
    });

    it('distance is symmetric', () =>
    {
        const d1 = GeoQuery.haversine(40.7128, -74.0060, 51.5074, -0.1278);
        const d2 = GeoQuery.haversine(51.5074, -0.1278, 40.7128, -74.0060);
        expect(Math.abs(d1 - d2)).toBeLessThan(0.01);
    });

    it('London to Tokyo is approximately 9558 km', () =>
    {
        const dist = GeoQuery.haversine(51.5074, -0.1278, 35.6762, 139.6503);
        expect(dist).toBeGreaterThan(9500);
        expect(dist).toBeLessThan(9600);
    });
});

// ===================================================================
// distance (instance method)
// ===================================================================
describe('GeoQuery — distance', () =>
{
    it('uses configured unit', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng', unit: 'mi' });
        const dist = geo.distance(40.7128, -74.0060, 34.0522, -118.2437);
        expect(dist).toBeGreaterThan(2400);
        expect(dist).toBeLessThan(2500);
    });

    it('unit override takes precedence', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng', unit: 'km' });
        const distMi = geo.distance(40.7128, -74.0060, 34.0522, -118.2437, 'mi');
        expect(distMi).toBeGreaterThan(2400);
        expect(distMi).toBeLessThan(2500);
    });
});

// ===================================================================
// near
// ===================================================================
describe('GeoQuery — near', () =>
{
    let db, Store, geo;

    beforeEach(async () =>
    {
        db = memDb();
        Store = makeModel(db, 'stores', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
            lat:  { type: 'float', required: true },
            lng:  { type: 'float', required: true },
        }, { name: 'Store' });
        await db.sync();

        // NYC Times Square
        await Store.create({ name: 'Times Square', lat: 40.7580, lng: -73.9855 });
        // Brooklyn (12km from TS)
        await Store.create({ name: 'Brooklyn', lat: 40.6782, lng: -73.9442 });
        // Jersey City (7km from TS)
        await Store.create({ name: 'Jersey City', lat: 40.7178, lng: -74.0431 });
        // Boston (306km from TS)
        await Store.create({ name: 'Boston', lat: 42.3601, lng: -71.0589 });

        geo = new GeoQuery(Store, { latField: 'lat', lngField: 'lng' });
    });

    it('returns all records sorted by distance', async () =>
    {
        const results = await geo.near(40.7580, -73.9855);
        expect(results.length).toBe(4);
        expect(results[0].name).toBe('Times Square');
        expect(results[0]._distance).toBe(0);
    });

    it('results include _distance by default', async () =>
    {
        const results = await geo.near(40.7580, -73.9855);
        for (const r of results)
        {
            expect(r._distance).toBeDefined();
            expect(typeof r._distance).toBe('number');
        }
    });

    it('filters by radius', async () =>
    {
        // Only within 15km of Times Square
        const results = await geo.near(40.7580, -73.9855, { radius: 15 });
        expect(results.length).toBe(3); // TS, Brooklyn, Jersey City
        expect(results.every(r => r.name !== 'Boston')).toBe(true);
    });

    it('limits results', async () =>
    {
        const results = await geo.near(40.7580, -73.9855, { limit: 2 });
        expect(results.length).toBe(2);
    });

    it('offsets results', async () =>
    {
        const all = await geo.near(40.7580, -73.9855);
        const offset = await geo.near(40.7580, -73.9855, { offset: 1 });
        expect(offset.length).toBe(all.length - 1);
        expect(offset[0].name).toBe(all[1].name);
    });

    it('filters with where conditions', async () =>
    {
        const results = await geo.near(40.7580, -73.9855, { where: { name: 'Boston' } });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Boston');
    });

    it('unit override in near()', async () =>
    {
        const results = await geo.near(40.7580, -73.9855, { unit: 'mi', radius: 10 });
        // 10 miles ≈ 16km, should include TS, Brooklyn, Jersey City
        expect(results.length).toBe(3);
    });

    it('includeDistance=false omits _distance', async () =>
    {
        const results = await geo.near(40.7580, -73.9855, { includeDistance: false });
        expect(results[0]._distance).toBeUndefined();
    });

    it('throws without registered model', async () =>
    {
        const M = class extends Model { static table = 'ghost'; };
        const g = new GeoQuery(M, { latField: 'lat', lngField: 'lng' });
        await expect(g.near(0, 0)).rejects.toThrow();
    });

    it('skips rows with null lat/lng', async () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'null_geo', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            lat: { type: 'float', nullable: true },
            lng: { type: 'float', nullable: true },
        }, { name: 'NullGeo' });
        await db2.sync();
        await M.create({ lat: null, lng: null });
        await M.create({ lat: 40.7, lng: -74.0 });

        const g = new GeoQuery(M, { latField: 'lat', lngField: 'lng' });
        const results = await g.near(40.7, -74.0);
        expect(results.length).toBe(1);
    });
});

// ===================================================================
// within
// ===================================================================
describe('GeoQuery — within', () =>
{
    let db, Store, geo;

    beforeEach(async () =>
    {
        db = memDb();
        Store = makeModel(db, 'within_stores', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
            lat:  { type: 'float', required: true },
            lng:  { type: 'float', required: true },
        }, { name: 'WithinStore' });
        await db.sync();

        await Store.create({ name: 'In Box', lat: 40.75, lng: -73.99 });
        await Store.create({ name: 'Out Box', lat: 41.0, lng: -74.2 });

        geo = new GeoQuery(Store, { latField: 'lat', lngField: 'lng' });
    });

    it('returns records within bounding box', async () =>
    {
        const results = await geo.within({
            north: 40.8, south: 40.7, east: -73.9, west: -74.0,
        });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('In Box');
    });

    it('throws with incomplete bounds', async () =>
    {
        await expect(geo.within({ north: 40 })).rejects.toThrow('bounds');
        await expect(geo.within(null)).rejects.toThrow('bounds');
    });

    it('respects limit', async () =>
    {
        await Store.create({ name: 'Also In', lat: 40.76, lng: -73.95 });
        const results = await geo.within({
            north: 40.8, south: 40.7, east: -73.9, west: -74.0,
        }, { limit: 1 });
        expect(results.length).toBe(1);
    });

    it('applies additional where conditions', async () =>
    {
        await Store.create({ name: 'Also In', lat: 40.76, lng: -73.95 });
        const results = await geo.within({
            north: 40.8, south: 40.7, east: -73.9, west: -74.0,
        }, { where: { name: 'In Box' } });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('In Box');
    });
});

// ===================================================================
// isWithinRadius
// ===================================================================
describe('GeoQuery — isWithinRadius', () =>
{
    let geo;

    beforeEach(() =>
    {
        geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
    });

    it('returns true when within radius', () =>
    {
        // Same point
        expect(geo.isWithinRadius(40.7, -74.0, 40.7, -74.0, 1)).toBe(true);
    });

    it('returns false when outside radius', () =>
    {
        // NYC to LA
        expect(geo.isWithinRadius(40.7128, -74.0060, 34.0522, -118.2437, 100)).toBe(false);
    });

    it('uses configured unit', () =>
    {
        const geoMi = new GeoQuery(Model, { latField: 'lat', lngField: 'lng', unit: 'mi' });
        // NY to LA ~3944km = ~2451mi
        expect(geoMi.isWithinRadius(40.7128, -74.0060, 34.0522, -118.2437, 2500)).toBe(true);
        expect(geoMi.isWithinRadius(40.7128, -74.0060, 34.0522, -118.2437, 2400)).toBe(false);
    });

    it('unit override in isWithinRadius', () =>
    {
        // Use km geo, but override to mi
        expect(geo.isWithinRadius(40.7128, -74.0060, 34.0522, -118.2437, 2500, 'mi')).toBe(true);
    });
});

// ===================================================================
// toGeoJSON
// ===================================================================
describe('GeoQuery — toGeoJSON', () =>
{
    let geo;

    beforeEach(() =>
    {
        geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
    });

    it('converts record to GeoJSON Feature', () =>
    {
        const feature = geo.toGeoJSON({ id: 1, name: 'Store', lat: 40.7, lng: -74.0 });
        expect(feature.type).toBe('Feature');
        expect(feature.geometry.type).toBe('Point');
        expect(feature.geometry.coordinates).toEqual([-74.0, 40.7]); // [lng, lat]
    });

    it('includes all non-geo fields in properties by default', () =>
    {
        const feature = geo.toGeoJSON({ id: 1, name: 'Store', lat: 40.7, lng: -74.0, rating: 5 });
        expect(feature.properties.id).toBe(1);
        expect(feature.properties.name).toBe('Store');
        expect(feature.properties.rating).toBe(5);
        expect(feature.properties.lat).toBeUndefined();
        expect(feature.properties.lng).toBeUndefined();
    });

    it('includes only specified properties', () =>
    {
        const feature = geo.toGeoJSON(
            { id: 1, name: 'Store', lat: 40.7, lng: -74.0, rating: 5 },
            { properties: ['name'] },
        );
        expect(feature.properties.name).toBe('Store');
        expect(feature.properties.id).toBeUndefined();
        expect(feature.properties.rating).toBeUndefined();
    });

    it('works with model instances (toJSON)', () =>
    {
        const obj = {
            lat: 40.7, lng: -74.0, id: 1,
            toJSON() { return { id: this.id, lat: this.lat, lng: this.lng }; },
        };
        const feature = geo.toGeoJSON(obj);
        expect(feature.properties.id).toBe(1);
    });
});

// ===================================================================
// toGeoJSONCollection
// ===================================================================
describe('GeoQuery — toGeoJSONCollection', () =>
{
    it('creates a FeatureCollection', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
        const records = [
            { id: 1, lat: 40.7, lng: -74.0 },
            { id: 2, lat: 34.0, lng: -118.2 },
        ];
        const fc = geo.toGeoJSONCollection(records);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features.length).toBe(2);
        expect(fc.features[0].type).toBe('Feature');
    });

    it('passes options to each feature', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
        const records = [{ id: 1, name: 'A', lat: 40.7, lng: -74.0 }];
        const fc = geo.toGeoJSONCollection(records, { properties: ['name'] });
        expect(fc.features[0].properties.name).toBe('A');
        expect(fc.features[0].properties.id).toBeUndefined();
    });

    it('empty array returns empty collection', () =>
    {
        const geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
        const fc = geo.toGeoJSONCollection([]);
        expect(fc.features).toEqual([]);
    });
});

// ===================================================================
// fromGeoJSON
// ===================================================================
describe('GeoQuery — fromGeoJSON', () =>
{
    let geo;

    beforeEach(() =>
    {
        geo = new GeoQuery(Model, { latField: 'lat', lngField: 'lng' });
    });

    it('extracts lat/lng from Point Feature', () =>
    {
        const data = geo.fromGeoJSON({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-74.0, 40.7] },
            properties: { name: 'Store' },
        });
        expect(data.lat).toBe(40.7);
        expect(data.lng).toBe(-74.0);
        expect(data.name).toBe('Store');
    });

    it('throws for non-Feature', () =>
    {
        expect(() => geo.fromGeoJSON(null)).toThrow('Invalid GeoJSON');
        expect(() => geo.fromGeoJSON({ type: 'Polygon' })).toThrow('Invalid GeoJSON');
    });

    it('throws for non-Point geometry', () =>
    {
        expect(() => geo.fromGeoJSON({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
            properties: {},
        })).toThrow('Only Point');
    });
});

// ===================================================================
// Coordinate validation (security)
// ===================================================================
describe('GeoQuery — coordinate validation (security)', () =>
{
    let db, geo;

    beforeEach(async () =>
    {
        db = memDb();
        const Location = makeModel(db, 'locations', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            lat: { type: 'float' },
            lng: { type: 'float' },
        });
        await db.sync();
        geo = new GeoQuery(db, { model: Location, latField: 'lat', lngField: 'lng' });
    });

    it('near() rejects NaN coordinates', async () =>
    {
        await expect(geo.near(NaN, 1)).rejects.toThrow('finite numbers');
        await expect(geo.near(1, NaN)).rejects.toThrow('finite numbers');
    });

    it('near() rejects Infinity coordinates', async () =>
    {
        await expect(geo.near(Infinity, 1)).rejects.toThrow('finite numbers');
        await expect(geo.near(1, -Infinity)).rejects.toThrow('finite numbers');
    });

    it('near() rejects negative radius', async () =>
    {
        await expect(geo.near(40, -74, { radius: -5 })).rejects.toThrow('non-negative finite');
    });

    it('near() rejects Infinity radius', async () =>
    {
        await expect(geo.near(40, -74, { radius: Infinity })).rejects.toThrow('non-negative finite');
    });

    it('within() rejects NaN bounds', async () =>
    {
        await expect(geo.within({ north: NaN, south: 40, east: -73, west: -74 })).rejects.toThrow('finite numbers');
    });

    it('within() rejects Infinity bounds', async () =>
    {
        await expect(geo.within({ north: 42, south: Infinity, east: -73, west: -74 })).rejects.toThrow('finite numbers');
    });

    it('within() rejects missing bounds', async () =>
    {
        await expect(geo.within(null)).rejects.toThrow('finite numbers');
    });
});
