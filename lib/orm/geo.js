/**
 * @module orm/geo
 * @description Geo-spatial query support for the ORM.
 *              Provides distance calculations, bounding box queries,
 *              radius searches, and GeoJSON support.
 *              Works with in-memory adapters using Haversine formula;
 *              SQL adapters can use native spatial extensions (PostGIS, MySQL spatial).
 *
 * @section Geo-Spatial Queries
 *
 * @example
 *   const { GeoQuery } = require('zero-http');
 *
 *   // Create a geo query helper for a model
 *   const geo = new GeoQuery(Store, {
 *       latField: 'latitude',
 *       lngField: 'longitude',
 *   });
 *
 *   // Find stores within 10km of a point
 *   const nearby = await geo.near(40.7128, -74.0060, { radius: 10 });
 *
 *   // Find stores within a bounding box
 *   const inBox = await geo.within({
 *       north: 40.8, south: 40.6,
 *       east: -73.9, west: -74.1,
 *   });
 */

const log = require('../debug')('zero:orm:geo');

// -- Constants --------------------------------------------

/**
 * Earth's radius in kilometres.
 * @const {number}
 */
const EARTH_RADIUS_KM = 6371;

/**
 * Earth's radius in miles.
 * @const {number}
 */
const EARTH_RADIUS_MI = 3959;

// -- GeoQuery class ---------------------------------------

/**
 * Geo-spatial query builder for ORM models.
 * Provides distance-based searches, bounding box queries,
 * and GeoJSON conversion utilities.
 */
class GeoQuery
{
    /**
     * @constructor
     * @param {typeof Model} ModelClass - Model class with location data.
     * @param {object}       options    - Configuration options.
     * @param {string}       options.latField   - Column name for latitude.
     * @param {string}       options.lngField   - Column name for longitude.
     * @param {string}       [options.unit='km'] - Distance unit: 'km' or 'mi'.
     */
    constructor(ModelClass, options = {})
    {
        if (!ModelClass) throw new Error('GeoQuery requires a Model class');
        if (!options.latField) throw new Error('GeoQuery requires latField option');
        if (!options.lngField) throw new Error('GeoQuery requires lngField option');

        /** @type {typeof Model} */
        this._model = ModelClass;

        /** @type {string} Latitude column name. */
        this._latField = options.latField;

        /** @type {string} Longitude column name. */
        this._lngField = options.lngField;

        /** @type {string} Distance unit. */
        this._unit = options.unit || 'km';
    }

    /**
     * Find records near a geographic point.
     * Uses Haversine formula for distance calculation.
     *
     * @param {number} lat           - Latitude of the center point.
     * @param {number} lng           - Longitude of the center point.
     * @param {object} [options]     - Search options.
     * @param {number} [options.radius]    - Maximum distance (in configured unit).
     * @param {number} [options.limit]     - Maximum number of results.
     * @param {number} [options.offset]    - Skip N results.
     * @param {object} [options.where]     - Additional WHERE conditions.
     * @param {string} [options.unit]      - Override distance unit ('km' or 'mi').
     * @param {boolean} [options.includeDistance=true] - Add `_distance` property to results.
     * @returns {Promise<Array<object>>} Records sorted by distance, with `_distance` property.
     *
     * @example
     *   // Find 5 nearest stores within 25km
     *   const stores = await geo.near(40.7128, -74.0060, {
     *       radius: 25,
     *       limit: 5,
     *   });
     *   stores[0]._distance // => 1.23 (km)
     */
    async near(lat, lng, options = {})
    {
        lat = Number(lat);
        lng = Number(lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
        {
            throw new Error('lat and lng must be finite numbers');
        }

        const {
            radius,
            limit,
            offset = 0,
            where = {},
            unit = this._unit,
            includeDistance = true,
        } = options;

        if (radius !== undefined && (!Number.isFinite(Number(radius)) || Number(radius) < 0))
        {
            throw new Error('radius must be a non-negative finite number');
        }

        const adapter = this._model._adapter;
        if (!adapter) throw new Error('Model is not registered with a database');

        // Use adapter-native geo search if available
        if (typeof adapter.geoNear === 'function')
        {
            return adapter.geoNear(this._model.table, this._latField, this._lngField, lat, lng, {
                radius, limit, offset, where, unit, model: this._model,
            });
        }

        // Fallback: in-memory Haversine calculation
        return this._memoryNear(lat, lng, { radius, limit, offset, where, unit, includeDistance });
    }

    /**
     * Find records within a bounding box.
     *
     * @param {object} bounds        - Bounding box coordinates.
     * @param {number} bounds.north  - Northern latitude boundary.
     * @param {number} bounds.south  - Southern latitude boundary.
     * @param {number} bounds.east   - Eastern longitude boundary.
     * @param {number} bounds.west   - Western longitude boundary.
     * @param {object} [options]     - Query options.
     * @param {number} [options.limit]     - Maximum results.
     * @param {object} [options.where]     - Additional WHERE conditions.
     * @returns {Promise<Array<object>>} Records within the bounding box.
     *
     * @example
     *   const stores = await geo.within({
     *       north: 40.8, south: 40.6,
     *       east: -73.9, west: -74.1,
     *   });
     */
    async within(bounds, options = {})
    {
        if (!bounds || !Number.isFinite(bounds.north) || !Number.isFinite(bounds.south) ||
            !Number.isFinite(bounds.east) || !Number.isFinite(bounds.west))
        {
            throw new Error('within() requires bounds with north, south, east, and west as finite numbers');
        }

        const { limit, where = {} } = options;

        let q = this._model.query()
            .where(this._latField, '>=', bounds.south)
            .where(this._latField, '<=', bounds.north)
            .where(this._lngField, '>=', bounds.west)
            .where(this._lngField, '<=', bounds.east);

        if (Object.keys(where).length) q = q.where(where);
        if (limit) q = q.limit(limit);

        return q.exec();
    }

    /**
     * Calculate the distance between two geographic points.
     * Uses the Haversine formula.
     *
     * @param {number} lat1 - Latitude of point 1.
     * @param {number} lng1 - Longitude of point 1.
     * @param {number} lat2 - Latitude of point 2.
     * @param {number} lng2 - Longitude of point 2.
     * @param {string} [unit] - Distance unit ('km' or 'mi'). Defaults to configured unit.
     * @returns {number} Distance between the two points.
     *
     * @example
     *   const dist = geo.distance(40.7128, -74.0060, 34.0522, -118.2437);
     *   // => 3944.42 (km)
     */
    distance(lat1, lng1, lat2, lng2, unit)
    {
        return GeoQuery.haversine(lat1, lng1, lat2, lng2, unit || this._unit);
    }

    /**
     * Calculate the Haversine distance between two points.
     *
     * @param {number} lat1 - Latitude of point 1 (degrees).
     * @param {number} lng1 - Longitude of point 1 (degrees).
     * @param {number} lat2 - Latitude of point 2 (degrees).
     * @param {number} lng2 - Longitude of point 2 (degrees).
     * @param {string} [unit='km'] - Distance unit: 'km' or 'mi'.
     * @returns {number} Distance in the specified unit.
     */
    static haversine(lat1, lng1, lat2, lng2, unit = 'km')
    {
        const R = unit === 'mi' ? EARTH_RADIUS_MI : EARTH_RADIUS_KM;
        const toRad = (deg) => deg * (Math.PI / 180);

        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Convert a record to GeoJSON Point feature.
     *
     * @param {object} record       - Model instance or plain object.
     * @param {object} [options]    - Configuration options.
     * @param {string[]} [options.properties] - Fields to include in GeoJSON properties.
     * @returns {object} GeoJSON Feature object.
     *
     * @example
     *   const feature = geo.toGeoJSON(store);
     *   // => { type: 'Feature', geometry: { type: 'Point', coordinates: [-74.006, 40.7128] }, properties: { ... } }
     */
    toGeoJSON(record, options = {})
    {
        const lat = record[this._latField];
        const lng = record[this._lngField];

        const properties = {};
        const propFields = options.properties;
        if (propFields)
        {
            for (const f of propFields)
            {
                if (record[f] !== undefined) properties[f] = record[f];
            }
        }
        else
        {
            // Include all non-geo fields
            const data = record.toJSON ? record.toJSON() : { ...record };
            for (const [k, v] of Object.entries(data))
            {
                if (k !== this._latField && k !== this._lngField)
                {
                    properties[k] = v;
                }
            }
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [lng, lat], // GeoJSON is [lng, lat]
            },
            properties,
        };
    }

    /**
     * Convert multiple records to a GeoJSON FeatureCollection.
     *
     * @param {Array<object>} records  - Array of model instances or plain objects.
     * @param {object} [options]       - Configuration options.
     * @param {string[]} [options.properties] - Fields to include in each feature's properties.
     * @returns {object} GeoJSON FeatureCollection.
     *
     * @example
     *   const collection = geo.toGeoJSONCollection(stores);
     *   // => { type: 'FeatureCollection', features: [...] }
     */
    toGeoJSONCollection(records, options = {})
    {
        return {
            type: 'FeatureCollection',
            features: records.map(r => this.toGeoJSON(r, options)),
        };
    }

    /**
     * Create a model instance from a GeoJSON Feature.
     *
     * @param {object} feature - GeoJSON Feature with Point geometry.
     * @returns {object} Plain data object ready for Model.create().
     *
     * @example
     *   const data = geo.fromGeoJSON(feature);
     *   const store = await Store.create(data);
     */
    fromGeoJSON(feature)
    {
        if (!feature || feature.type !== 'Feature' || !feature.geometry)
        {
            throw new Error('Invalid GeoJSON Feature');
        }
        if (feature.geometry.type !== 'Point')
        {
            throw new Error('Only Point geometry is supported');
        }

        const [lng, lat] = feature.geometry.coordinates;
        const data = { ...feature.properties };
        data[this._latField] = lat;
        data[this._lngField] = lng;
        return data;
    }

    /**
     * Check if a point is within a given radius of a center point.
     *
     * @param {number} lat      - Point latitude.
     * @param {number} lng      - Point longitude.
     * @param {number} centerLat - Center latitude.
     * @param {number} centerLng - Center longitude.
     * @param {number} radius   - Radius to check.
     * @param {string} [unit]   - Distance unit.
     * @returns {boolean} True if the point is within the radius.
     */
    isWithinRadius(lat, lng, centerLat, centerLng, radius, unit)
    {
        const dist = this.distance(lat, lng, centerLat, centerLng, unit);
        return dist <= radius;
    }

    /**
     * In-memory near search with Haversine distance.
     * @param {number} lat - Center latitude.
     * @param {number} lng - Center longitude.
     * @param {object} options - Search options.
     * @returns {Promise<Array>} Sorted results with _distance.
     * @private
     */
    async _memoryNear(lat, lng, options = {})
    {
        const { radius, limit, offset = 0, where = {}, unit = this._unit, includeDistance = true } = options;

        let q = this._model.query();
        if (Object.keys(where).length) q = q.where(where);
        const allRows = await q.exec();

        const scored = [];
        for (const row of allRows)
        {
            const rowLat = row[this._latField];
            const rowLng = row[this._lngField];
            if (rowLat == null || rowLng == null) continue;

            const dist = GeoQuery.haversine(lat, lng, rowLat, rowLng, unit);

            if (radius !== undefined && dist > radius) continue;

            const data = row.toJSON ? row.toJSON() : { ...row };
            if (includeDistance) data._distance = Math.round(dist * 100) / 100;
            scored.push({ data, dist });
        }

        // Sort by distance
        scored.sort((a, b) => a.dist - b.dist);

        let results = scored.map(s => s.data);
        if (offset) results = results.slice(offset);
        if (limit) results = results.slice(0, limit);

        return results;
    }
}

module.exports = { GeoQuery, EARTH_RADIUS_KM, EARTH_RADIUS_MI };
