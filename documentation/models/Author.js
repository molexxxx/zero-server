const { Model, TYPES } = require('../..');

class Author extends Model
{
    static table = 'authors';
    static timestamps = true;
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING, required: true, minLength: 1, maxLength: 100 },
        email: { type: TYPES.STRING, required: true, maxLength: 200, match: /^[^@]+@[^@]+\.[^@]+$/ },
        bio:   { type: TYPES.STRING, default: '', maxLength: 500 },
        role:  { type: TYPES.STRING, default: 'author', enum: ['author', 'editor', 'admin'] },
    };

    static scopes = {
        author:  (q) => q.where('role', 'author'),
        editors: (q) => q.where('role', 'editor'),
        admins:  (q) => q.where('role', 'admin'),
    };

    static hooks = {
        beforeCreate(data)
        {
            if (data.name) data.name = data.name.trim();
            if (data.email) data.email = data.email.toLowerCase().trim();
            return data;
        },
    };

    static _relations = {
        Post: { type: 'hasMany', foreignKey: 'authorId' },
    };
}

module.exports = Author;
