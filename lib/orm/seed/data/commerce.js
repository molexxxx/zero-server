'use strict';

/**
 * @module seed/data/commerce
 * @description Data pools for commerce, product, and company fake data.
 */

/** Adjectives applied to product names. */
const PRODUCT_ADJECTIVES = [
    'Ergonomic', 'Electronic', 'Smart', 'Professional', 'Ultra', 'Premium',
    'Heavy-Duty', 'Lightweight', 'Compact', 'Portable', 'Advanced', 'Wireless',
    'Digital', 'Classic', 'Modern', 'Handcrafted', 'Luxurious', 'Eco-Friendly',
    'Industrial', 'Vintage', 'Rustic', 'Sleek', 'Durable', 'Flexible',
    'Multi-Purpose', 'Automated', 'Intelligent', 'Refined', 'Next-Gen', 'Essential',
];

/** Materials for product names. */
const PRODUCT_MATERIALS = [
    'Steel', 'Wooden', 'Leather', 'Plastic', 'Marble', 'Metal', 'Concrete',
    'Bronze', 'Bamboo', 'Aluminum', 'Carbon Fiber', 'Ceramic', 'Glass',
    'Crystal', 'Silk', 'Cotton', 'Copper', 'Iron', 'Granite', 'Rubber',
    'Titanium', 'Brass', 'Linen', 'Mesh', 'Polyester', 'Nylon', 'Wool',
];

/** Product category nouns. */
const PRODUCT_NOUNS = [
    'Chair', 'Table', 'Shirt', 'Ball', 'Gloves', 'Pants', 'Shoes', 'Hat',
    'Keyboard', 'Mouse', 'Monitor', 'Laptop', 'Phone', 'Tablet', 'Speaker',
    'Watch', 'Bag', 'Wallet', 'Coat', 'Glasses', 'Lamp', 'Desk', 'Shelf',
    'Pillow', 'Blanket', 'Towel', 'Mug', 'Bottle', 'Bowl', 'Knife', 'Pan',
    'Bike', 'Helmet', 'Rack', 'Stand', 'Holder', 'Case', 'Cover', 'Mount',
    'Charger', 'Cable', 'Drive', 'Camera', 'Headphones', 'Microphone', 'Printer',
    'Mat', 'Brush', 'Comb', 'Mirror', 'Clock', 'Frame', 'Candle', 'Vase',
];

/** Top-level product category names. */
const CATEGORIES = [
    'Electronics', 'Clothing & Apparel', 'Food & Beverages', 'Home & Garden',
    'Sports & Outdoors', 'Books & Media', 'Toys & Games', 'Health & Beauty',
    'Automotive', 'Office Supplies', 'Jewelry & Accessories', 'Pet Supplies',
    'Baby & Kids', 'Tools & Hardware', 'Travel & Luggage', 'Music & Instruments',
    'Art & Crafts', 'Software & Apps', 'Industrial Equipment', 'Collectibles',
    'Furniture', 'Kitchen & Dining', 'Lighting', 'Garden Tools', 'Fitness',
];

/** Business department names. */
const DEPARTMENTS = [
    'Engineering', 'Marketing', 'Sales', 'Finance', 'Human Resources',
    'Operations', 'Legal', 'Product', 'Design', 'Customer Success',
    'Research & Development', 'IT', 'Security', 'Data Science', 'Supply Chain',
    'Quality Assurance', 'Business Development', 'Communications', 'Analytics',
    'Compliance', 'Strategy', 'Procurement', 'Manufacturing', 'Logistics',
];

/** First part of a generated company name. */
const COMPANY_ADJECTIVES = [
    'Innovative', 'Global', 'Dynamic', 'Advanced', 'Premier', 'Elite',
    'National', 'Digital', 'Strategic', 'Integrated', 'Unified', 'Nexus',
    'Alpha', 'Apex', 'Vertex', 'Summit', 'Pinnacle', 'Horizon', 'Stellar',
    'Quantum', 'Fusion', 'Synergy', 'Core', 'Prime', 'Precision', 'Vantage',
    'Catalyst', 'Axiom', 'Aether', 'Titanium', 'Ironclad', 'Luminary',
];

/** Second part of a generated company name. */
const COMPANY_NOUNS = [
    'Technologies', 'Solutions', 'Systems', 'Industries', 'Group',
    'Partners', 'Ventures', 'Labs', 'Works', 'Consulting', 'Services',
    'Analytics', 'Media', 'Networks', 'Designs', 'Innovations', 'Enterprises',
    'Digital', 'Cloud', 'Data', 'Security', 'Health', 'Finance', 'Capital',
    'Dynamics', 'Intelligence', 'Platforms', 'Insights', 'Studio', 'Agency',
];

/** Company legal-entity suffixes. */
const COMPANY_SUFFIXES = [
    'Inc.', 'LLC', 'Corp.', 'Ltd.', 'Co.', 'Group', 'Holdings', 'International',
];

/** Industry sector names. */
const INDUSTRIES = [
    'Information Technology', 'Financial Services', 'Healthcare', 'Retail',
    'Manufacturing', 'Transportation & Logistics', 'Media & Entertainment',
    'Telecommunications', 'Education', 'Real Estate', 'Hospitality & Tourism',
    'Aerospace & Defense', 'Energy & Utilities', 'Agriculture', 'Construction',
    'Pharmaceuticals', 'Automotive', 'Insurance', 'Non-Profit', 'Government',
    'Consulting', 'E-commerce', 'Cybersecurity', 'Artificial Intelligence',
    'Blockchain & Crypto', 'Biotechnology', 'Clean Energy', 'Legal Services',
];

/** Buzzword adjectives for catch phrases. */
const CATCH_PHRASE_ADJECTIVES = [
    'Adaptive', 'Advanced', 'Automated', 'Balanced', 'Business-focused',
    'Centralized', 'Compatible', 'Configurable', 'Cross-platform', 'Customer-focused',
    'Decentralized', 'Digitized', 'Distributed', 'Enhanced', 'Enterprise-wide',
    'Ergonomic', 'Expanded', 'Face to face', 'Focused', 'Front-line',
    'Fully-configurable', 'Function-based', 'Future-proofed', 'Horizontal',
    'Implemented', 'Innovative', 'Integrated', 'Intuitive', 'Managed', 'Monitored',
    'Multi-channelled', 'Multi-lateral', 'Multi-tiered', 'Networked', 'Object-based',
    'Open-architected', 'Open-source', 'Optimized', 'Organic', 'Organized',
    'Pre-emptive', 'Proactive', 'Profit-focused', 'Programmable', 'Progressive',
    'Quality-focused', 'Re-engineered', 'Reactive', 'Reduced', 'Right-sized',
    'Robust', 'Seamless', 'Secured', 'Self-enabling', 'Streamlined', 'Synchronized',
    'Synergistic', 'Team-oriented', 'Universal', 'User-centric', 'User-friendly',
    'Versatile', 'Virtual', 'Visionary', 'Vision-oriented',
];

/** Buzzword nouns for catch phrases. */
const CATCH_PHRASE_NOUNS = [
    'ability', 'access', 'adapter', 'algorithm', 'alliance', 'analyzer', 'archive',
    'array', 'attitude', 'benchmark', 'capability', 'capacity', 'challenge',
    'circuit', 'collaboration', 'complexity', 'concept', 'contingency',
    'core', 'database', 'data-warehouse', 'definition', 'emulation', 'encoding',
    'encryption', 'extranet', 'firmware', 'flexibility', 'focus group',
    'forecast', 'frame', 'framework', 'function', 'functionalities', 'hub',
    'implementation', 'info-mediaries', 'infrastructure', 'initiative', 'installation',
    'instruction set', 'interface', 'internet solution', 'intranet', 'knowledge user',
    'knowledge base', 'local area network', 'leverage', 'matrix', 'methodology',
    'middleware', 'migration', 'model', 'moderator', 'moratorium', 'neural-net',
    'open architecture', 'open system', 'orchestration', 'paradigm', 'policy',
    'portal', 'pricing structure', 'process improvement', 'product', 'productivity',
    'project', 'projection', 'protocol', 'throughput', 'time-frame', 'toolset',
    'transition', 'utilisation', 'website', 'workforce',
];

module.exports = {
    PRODUCT_ADJECTIVES,
    PRODUCT_MATERIALS,
    PRODUCT_NOUNS,
    CATEGORIES,
    DEPARTMENTS,
    COMPANY_ADJECTIVES,
    COMPANY_NOUNS,
    COMPANY_SUFFIXES,
    INDUSTRIES,
    CATCH_PHRASE_ADJECTIVES,
    CATCH_PHRASE_NOUNS,
};
