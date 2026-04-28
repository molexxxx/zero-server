const { Model, TYPES } = require('../..');

class Post extends Model
{
    static table = 'posts';
    static timestamps = true;
    static softDelete = true;
    static schema = {
        id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        authorId: { type: TYPES.INTEGER, required: true },
        title:    { type: TYPES.STRING, required: true, minLength: 1, maxLength: 300 },
        body:     { type: TYPES.STRING, default: '', maxLength: 5000 },
        category: { type: TYPES.STRING, default: 'general', enum: ['general', 'tutorial', 'news', 'review'] },
        status:   { type: TYPES.STRING, default: 'draft', enum: ['draft', 'published', 'archived'] },
        views:    { type: TYPES.INTEGER, default: 0, min: 0 },
    };

    static scopes = {
        published:  (q) => q.where('status', 'published'),
        drafts:     (q) => q.where('status', 'draft'),
        popular:    (q) => q.where('views', '>=', 10).orderBy('views', 'desc'),
        byCategory: (q, cat) => q.where('category', cat),
        recent:     (q) => q.orderBy('createdAt', 'desc'),
    };

    static hooks = {
        beforeCreate(data)
        {
            if (data.title) data.title = data.title.trim();
            if (data.body) data.body = data.body.trim();
            return data;
        },
        beforeUpdate(data)
        {
            if (data.title) data.title = data.title.trim();
            if (data.body) data.body = data.body.trim();
            return data;
        },
    };

    static _relations = {
        Author: { type: 'belongsTo', foreignKey: 'authorId', model: 'Author' },
    };
}

module.exports = Post;
