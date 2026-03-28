const { Model, TYPES } = require('../..');

class Task extends Model
{
    static table = 'tasks';
    static timestamps = true;
    static softDelete = true;
    static schema = {
        id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        title:    { type: TYPES.STRING, required: true, maxLength: 200 },
        status:   { type: TYPES.STRING, default: 'pending', enum: ['pending', 'in-progress', 'done'] },
        priority: { type: TYPES.INTEGER, default: 0, min: 0, max: 5 },
    };
    static scopes = {
        active: (q) => q.where('status', '!=', 'done'),
        done:   (q) => q.where('status', '=', 'done'),
        highPriority: (q) => q.where('priority', '>=', 3),
    };
}

module.exports = Task;
