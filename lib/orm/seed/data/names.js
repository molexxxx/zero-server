'use strict';

/**
 * @module seed/data/names
 * @description Multi-locale name pools for fake person name generation.
 *              Supports 14 locales with separate male, female, and last-name arrays.
 *
 *  Supported locale codes:
 *    en  English (US / UK)      es  Spanish
 *    fr  French                 de  German
 *    it  Italian                pt  Portuguese / Brazilian
 *    ru  Russian (romanized)    ja  Japanese (romanized)
 *    zh  Chinese Mandarin (Pinyin)  ar  Arabic (romanized)
 *    hi  Hindi (romanized)      ko  Korean (romanized)
 *    nl  Dutch                  sv  Swedish / Nordic
 */

const NAMES = {

    // -- English -------------------------------------------------------------
    en: {
        male: [
            'James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard',
            'Joseph', 'Thomas', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark',
            'Donald', 'Steven', 'Kevin', 'Brian', 'George', 'Edward', 'Ronald',
            'Timothy', 'Kenneth', 'Jacob', 'Ryan', 'Eric', 'Nicholas', 'Jonathan',
            'Joshua', 'Andrew', 'Patrick', 'Justin', 'Brandon', 'Samuel', 'Nathan',
            'Christian', 'Dylan', 'Henry', 'Tyler', 'Ethan', 'Austin', 'Gabriel',
        ],
        female: [
            'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Margaret', 'Elizabeth',
            'Susan', 'Dorothy', 'Lisa', 'Nancy', 'Karen', 'Betty', 'Helen', 'Sandra',
            'Donna', 'Carol', 'Ruth', 'Sharon', 'Michelle', 'Laura', 'Sarah', 'Kimberly',
            'Deborah', 'Jessica', 'Shirley', 'Cynthia', 'Angela', 'Melissa', 'Ashley',
            'Amanda', 'Stephanie', 'Rebecca', 'Megan', 'Rachel', 'Emily', 'Samantha',
            'Katherine', 'Christina', 'Emma', 'Olivia', 'Sophia', 'Ava', 'Isabella',
        ],
        last: [
            'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
            'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
            'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
            'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
            'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King',
            'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams',
        ],
    },

    // -- Spanish -------------------------------------------------------------
    es: {
        male: [
            'Alejandro', 'Carlos', 'Miguel', 'Juan', 'José', 'Luis', 'Antonio',
            'Fernando', 'Eduardo', 'Roberto', 'Francisco', 'Diego', 'Andrés',
            'Sergio', 'Joaquín', 'Rodrigo', 'Javier', 'Rafael', 'Álvaro', 'Pablo',
            'Marcos', 'Héctor', 'Raúl', 'Ignacio', 'Sebastián', 'Tomás', 'Daniel',
            'Martín', 'Benjamín', 'Emilio', 'Adrián', 'Felipe', 'Óscar', 'Iván',
        ],
        female: [
            'María', 'Ana', 'Carmen', 'Isabel', 'Sofía', 'Valentina', 'Lucía',
            'Adriana', 'Elena', 'Gabriela', 'Patricia', 'Rosa', 'Fernanda', 'Andrea',
            'Cristina', 'Laura', 'Victoria', 'Alejandra', 'Paula', 'Natalia',
            'Daniela', 'Pilar', 'Mercedes', 'Beatriz', 'Guadalupe', 'Mónica',
            'Estrella', 'Raquel', 'Inés', 'Esperanza', 'Gloria', 'Marta', 'Silvia',
        ],
        last: [
            'García', 'Martínez', 'López', 'González', 'Sánchez', 'Rodríguez',
            'Pérez', 'Fernández', 'Torres', 'Ramírez', 'Flores', 'Cruz', 'Moreno',
            'Ortiz', 'Reyes', 'Herrera', 'Medina', 'Aguilar', 'Castro', 'Jiménez',
            'Vargas', 'Morales', 'Romero', 'Álvarez', 'Domínguez', 'Fuentes',
            'Mendoza', 'Rojas', 'Gutiérrez', 'Navarro', 'Díaz', 'Ruiz',
        ],
    },

    // -- French --------------------------------------------------------------
    fr: {
        male: [
            'Pierre', 'Jean', 'Michel', 'André', 'Louis', 'Philippe', 'Thomas',
            'Nicolas', 'Julien', 'Raphaël', 'Antoine', 'François', 'Henri',
            'Édouard', 'Sébastien', 'Vincent', 'Benoît', 'Guillaume', 'Stéphane',
            'Grégoire', 'Xavier', 'Clément', 'Yves', 'Luc', 'Christophe',
            'Maxime', 'Théo', 'Hugo', 'Mathieu', 'Baptiste',
        ],
        female: [
            'Marie', 'Hélène', 'Jeanne', 'Françoise', 'Nathalie', 'Isabelle',
            'Sophie', 'Camille', 'Lucie', 'Émilie', 'Anne', 'Claire', 'Amélie',
            'Chloé', 'Mathilde', 'Léa', 'Julie', 'Alice', 'Margot', 'Élise',
            'Anaïs', 'Charlotte', 'Pauline', 'Adèle', 'Justine', 'Manon',
            'Inès', 'Zoé', 'Valentine', 'Céline',
        ],
        last: [
            'Martin', 'Bernard', 'Thomas', 'Petit', 'Robert', 'Richard', 'Durand',
            'Dupont', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'David',
            'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Morel', 'Girard', 'André',
            'Lefèvre', 'Mercier', 'Dupuis', 'Lambert', 'Bonnet', 'François',
            'Martinez', 'Legrand', 'Garnier',
        ],
    },

    // -- German --------------------------------------------------------------
    de: {
        male: [
            'Hans', 'Klaus', 'Wolfgang', 'Karl', 'Friedrich', 'Werner', 'Walter',
            'Dieter', 'Gerhard', 'Jürgen', 'Martin', 'Stefan', 'Thomas', 'Andreas',
            'Markus', 'Michael', 'Peter', 'Christian', 'Tobias', 'Sebastian',
            'Florian', 'Jan', 'Felix', 'Lukas', 'Jonas', 'Luca', 'Leon', 'Noah',
            'Paul', 'Elias', 'Ben', 'Finn', 'Moritz', 'Philipp',
        ],
        female: [
            'Ursula', 'Ingrid', 'Anna', 'Maria', 'Elisabeth', 'Heike', 'Monika',
            'Claudia', 'Petra', 'Andrea', 'Sabine', 'Christine', 'Sandra', 'Katharina',
            'Julia', 'Lisa', 'Nina', 'Lena', 'Sarah', 'Leonie', 'Emma', 'Sophie',
            'Johanna', 'Laura', 'Hannah', 'Mia', 'Clara', 'Marie', 'Lea', 'Amelie',
        ],
        last: [
            'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner',
            'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter',
            'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann',
            'Braun', 'Krüger', 'Hartmann', 'Lange', 'Schmitt', 'Werner', 'Krause',
            'Lehmann', 'Walter', 'König', 'Huber',
        ],
    },

    // -- Italian -------------------------------------------------------------
    it: {
        male: [
            'Marco', 'Andrea', 'Luca', 'Giovanni', 'Francesco', 'Antonio', 'Mario',
            'Giuseppe', 'Alessandro', 'Lorenzo', 'Federico', 'Stefano', 'Matteo',
            'Paolo', 'Roberto', 'Giorgio', 'Alberto', 'Claudio', 'Riccardo', 'Davide',
            'Simone', 'Giacomo', 'Filippo', 'Nicola', 'Emanuele', 'Leonardo',
        ],
        female: [
            'Giulia', 'Sofia', 'Martina', 'Francesca', 'Sara', 'Alessia', 'Laura',
            'Anna', 'Chiara', 'Elena', 'Valentina', 'Federica', 'Marta', 'Elisa',
            'Camilla', 'Paola', 'Cristina', 'Silvia', 'Roberta', 'Serena',
            'Beatrice', 'Irene', 'Alessandra', 'Viviana', 'Arianna',
        ],
        last: [
            'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo',
            'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca',
            'Costa', 'Giordano', 'Mancini', 'Rizzo', 'Lombardi', 'Moretti',
            'Barbieri', 'Fontana', 'Santoro', 'Marini', 'Fabbri',
        ],
    },

    // -- Portuguese / Brazilian -----------------------------------------------
    pt: {
        male: [
            'João', 'Pedro', 'Paulo', 'Ricardo', 'Eduardo', 'Felipe', 'Gustavo',
            'André', 'Diego', 'Mateus', 'Rodrigo', 'Carlos', 'Thiago', 'Lucas',
            'Gabriel', 'Rafael', 'Henrique', 'Bruno', 'Alexandre', 'Igor',
            'Vitor', 'Renato', 'Otávio', 'Leandro', 'Sérgio',
        ],
        female: [
            'Ana', 'Maria', 'Fernanda', 'Juliana', 'Amanda', 'Camila', 'Patrícia',
            'Beatriz', 'Larissa', 'Gabriela', 'Renata', 'Isabela', 'Carolina',
            'Natália', 'Letícia', 'Viviane', 'Márcia', 'Adriana', 'Priscila', 'Aline',
            'Bruna', 'Daniela', 'Vanessa', 'Tatiana', 'Cristiane',
        ],
        last: [
            'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves',
            'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho',
            'Almeida', 'Lopes', 'Nunes', 'Freitas', 'Araujo', 'Correia',
            'Cardoso', 'Mendes', 'Pinto', 'Teixeira', 'Nascimento',
        ],
    },

    // -- Russian (romanized) --------------------------------------------------
    ru: {
        male: [
            'Alexander', 'Dmitry', 'Ivan', 'Maxim', 'Sergei', 'Andrei', 'Vladimir',
            'Nikolai', 'Pavel', 'Alexei', 'Mikhail', 'Vasily', 'Yuri', 'Boris',
            'Oleg', 'Viktor', 'Konstantin', 'Roman', 'Artem', 'Igor',
            'Evgeny', 'Fyodor', 'Leonid', 'Stanislav', 'Timur',
        ],
        female: [
            'Anna', 'Elena', 'Maria', 'Natalia', 'Olga', 'Tatiana', 'Irina',
            'Svetlana', 'Yulia', 'Ekaterina', 'Anastasia', 'Oksana', 'Vera',
            'Nina', 'Galina', 'Larisa', 'Valentina', 'Lyudmila', 'Sofia', 'Alina',
            'Ksenia', 'Daria', 'Polina', 'Vika', 'Margarita',
        ],
        last: [
            'Ivanov', 'Smirnov', 'Kuznetsov', 'Popov', 'Vasiliev', 'Petrov',
            'Sokolov', 'Mikhailov', 'Novikov', 'Fedorov', 'Morozov', 'Volkov',
            'Alexeyev', 'Lebedev', 'Semyonov', 'Egorov', 'Pavlov', 'Kozlov',
            'Stepanov', 'Nikolaev', 'Orlov', 'Andreev', 'Makarov', 'Nikitin',
        ],
    },

    // -- Japanese (romanized) -------------------------------------------------
    ja: {
        male: [
            'Haruto', 'Sota', 'Yuki', 'Ren', 'Kaito', 'Takumi', 'Kento', 'Ryu',
            'Shota', 'Hayato', 'Yamato', 'Daiki', 'Kenji', 'Hiroshi', 'Takeshi',
            'Masaki', 'Naoki', 'Ryota', 'Shunsuke', 'Yusuke', 'Kohei', 'Taichi',
            'Akira', 'Kazuki', 'Tsubasa',
        ],
        female: [
            'Yui', 'Aoi', 'Hina', 'Misaki', 'Koharu', 'Sakura', 'Nana', 'Rina',
            'Yuka', 'Miyu', 'Akane', 'Haruka', 'Mei', 'Riko', 'Saki', 'Momoko',
            'Ayane', 'Kanon', 'Moe', 'Sora', 'Hikari', 'Nozomi', 'Nanami',
            'Asuka', 'Kana',
        ],
        last: [
            'Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Yamamoto',
            'Nakamura', 'Kobayashi', 'Kato', 'Yoshida', 'Yamada', 'Sasaki',
            'Yamaguchi', 'Matsumoto', 'Inoue', 'Kimura', 'Hayashi', 'Shimizu',
            'Yamazaki', 'Mori', 'Abe', 'Ikeda', 'Hashimoto',
        ],
    },

    // -- Chinese Mandarin (Pinyin) ---------------------------------------------
    zh: {
        male: [
            'Wei', 'Hao', 'Ming', 'Lei', 'Jian', 'Tao', 'Feng', 'Long', 'Kai',
            'Bo', 'Kun', 'Yu', 'Gang', 'Cheng', 'Bin', 'Jie', 'Liang', 'Peng',
            'Dong', 'Zhe', 'Qi', 'Heng', 'Xuan', 'Rui', 'Chen',
        ],
        female: [
            'Yan', 'Xiu', 'Mei', 'Jun', 'Ling', 'Hua', 'Juan', 'Xiao', 'Jing',
            'Lin', 'Ping', 'Lan', 'Dan', 'Yi', 'Qing', 'Lu', 'Yun', 'Hong',
            'Fei', 'Rong', 'Xia', 'Zhen', 'Yue', 'Shan', 'Ying',
        ],
        last: [
            'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Wu', 'Zhao',
            'Zhou', 'Xu', 'Sun', 'Ma', 'Zhu', 'Hu', 'Guo', 'He', 'Lin', 'Gao',
            'Luo', 'Zheng', 'Liang', 'Xie', 'Tang', 'Han',
        ],
    },

    // -- Arabic (romanized) ---------------------------------------------------
    ar: {
        male: [
            'Mohammed', 'Ahmed', 'Ali', 'Omar', 'Khalid', 'Ibrahim', 'Yusuf',
            'Hamza', 'Hassan', 'Tariq', 'Karim', 'Samir', 'Nabil', 'Faris',
            'Zaid', 'Sami', 'Rami', 'Walid', 'Adel', 'Bilal', 'Amir', 'Nasser',
            'Riyadh', 'Tarek', 'Mostafa',
        ],
        female: [
            'Fatima', 'Aisha', 'Sara', 'Nour', 'Layla', 'Mariam', 'Zainab',
            'Hana', 'Rania', 'Dina', 'Yasmin', 'Amira', 'Salma', 'Lina', 'Alya',
            'Nadia', 'Rima', 'Rana', 'Samira', 'Nada', 'Heba', 'Mona', 'Suha',
            'Randa', 'Ghada',
        ],
        last: [
            'Al-Masri', 'Al-Rashid', 'Mansour', 'Nasser', 'Khalil', 'Hamdan',
            'Qasim', 'Saleh', 'Abboud', 'Barakat', 'Haddad', 'Khoury', 'Nassar',
            'Awad', 'Saad', 'Jabir', 'Othman', 'Aziz', 'Amin', 'Hassan',
            'Ibrahim', 'Omar', 'Abdullah', 'Yousef',
        ],
    },

    // -- Hindi (romanized) ----------------------------------------------------
    hi: {
        male: [
            'Rahul', 'Amit', 'Vijay', 'Rajesh', 'Suresh', 'Ankit', 'Mohit',
            'Aditya', 'Vishal', 'Sandeep', 'Rohit', 'Gaurav', 'Deepak', 'Sanjay',
            'Ravi', 'Ashish', 'Manish', 'Nikhil', 'Abhinav', 'Kartik', 'Arjun',
            'Dhruv', 'Varun', 'Karan', 'Pranav',
        ],
        female: [
            'Priya', 'Pooja', 'Neha', 'Asha', 'Kavita', 'Sunita', 'Rekha',
            'Anita', 'Sanjana', 'Meena', 'Shreya', 'Divya', 'Jyoti', 'Preeti',
            'Sonia', 'Ritu', 'Shilpa', 'Radha', 'Meera', 'Nisha', 'Anjali',
            'Tanvi', 'Swati', 'Deepa', 'Puja',
        ],
        last: [
            'Sharma', 'Patel', 'Verma', 'Gupta', 'Singh', 'Kumar', 'Mehta',
            'Joshi', 'Rao', 'Malhotra', 'Chopra', 'Nair', 'Yadav', 'Pandey',
            'Agarwal', 'Kapoor', 'Shukla', 'Srivastava', 'Dubey', 'Mishra',
            'Shah', 'Bose', 'Chatterjee', 'Mukherjee',
        ],
    },

    // -- Korean (romanized) ---------------------------------------------------
    ko: {
        male: [
            'Min-jun', 'Seo-jun', 'Do-yoon', 'Ji-ho', 'Jun-seo', 'Ye-jun',
            'Joon-woo', 'Hyun-woo', 'Min-hyuk', 'Jae-won', 'Sung-jin', 'Tae-yang',
            'Jin-ho', 'Ji-woo', 'Seung-hyun', 'Young-soo', 'Ki-tae', 'Dong-hyun',
            'Sung-min', 'Hyeon-jun', 'Woo-jin', 'Chan-woo', 'Jae-hyun', 'Hyun-jin',
        ],
        female: [
            'Seo-yeon', 'Min-seo', 'Ha-eun', 'Ji-woo', 'Soo-yeon', 'Na-yeon',
            'Hye-won', 'Eun-ji', 'So-hyun', 'Ji-yeon', 'Yoo-jin', 'Chae-won',
            'Min-ji', 'Ji-min', 'Soo-bin', 'Yun-ah', 'Da-eun', 'Hana', 'Ji-hye',
            'Bo-ra', 'Seul-gi', 'Ye-jin', 'Ha-ru', 'Na-eun',
        ],
        last: [
            'Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Chang',
            'Lim', 'Han', 'Oh', 'Seo', 'Shin', 'Kwon', 'Hwang', 'Ahn', 'Song',
            'Yoo', 'Hong', 'Jeon', 'Ko', 'Moon', 'Yang',
        ],
    },

    // -- Dutch ----------------------------------------------------------------
    nl: {
        male: [
            'Jan', 'Pieter', 'Hendrik', 'Willem', 'Johan', 'Dirk', 'Gerrit',
            'Bas', 'Sander', 'Ruben', 'Lars', 'Tim', 'Niels', 'Joost', 'Bram',
            'Thomas', 'Luca', 'Noah', 'Milan', 'Jesse', 'Daan', 'Finn', 'Tijs',
        ],
        female: [
            'Anna', 'Maria', 'Emma', 'Sophie', 'Julia', 'Lotte', 'Sara', 'Lisa',
            'Marieke', 'Inge', 'Femke', 'Noor', 'Fleur', 'Manon', 'Roos',
            'Iris', 'Sanne', 'Kim', 'Amber', 'Hannah', 'Ella', 'Fien',
        ],
        last: [
            'De Jong', 'Jansen', 'De Vries', 'Van den Berg', 'Van Dijk', 'Bakker',
            'Janssen', 'Visser', 'Smit', 'Meijer', 'De Boer', 'Mulder', 'Bos',
            'Vos', 'Peters', 'Hendriks', 'Van Leeuwen', 'Dekker', 'Brouwer',
            'De Wit', 'Dijkstra', 'Smits', 'Vermeulen',
        ],
    },

    // -- Swedish / Nordic -----------------------------------------------------
    sv: {
        male: [
            'Lars', 'Björn', 'Erik', 'Karl', 'Henrik', 'Anders', 'Sven', 'Johan',
            'Magnus', 'Mikael', 'Jonas', 'Peter', 'Nils', 'Olof', 'Gunnar',
            'Viktor', 'Axel', 'Liam', 'Elias', 'Isak', 'Oliver', 'Lucas', 'Hugo',
        ],
        female: [
            'Anna', 'Maria', 'Karin', 'Kristina', 'Ingrid', 'Eva', 'Sara', 'Emma',
            'Lena', 'Ulrika', 'Malin', 'Sofia', 'Maja', 'Alice', 'Julia', 'Elin',
            'Amanda', 'Ida', 'Johanna', 'Hanna', 'Alva', 'Filippa', 'Saga',
        ],
        last: [
            'Andersson', 'Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson',
            'Olsson', 'Persson', 'Svensson', 'Gustafsson', 'Pettersson', 'Jonsson',
            'Jansson', 'Hansson', 'Bengtsson', 'Lindqvist', 'Magnusson', 'Lindgren',
            'Jensen', 'Hansen', 'Andersen', 'Pedersen', 'Berg',
        ],
    },
};

/** All supported locale codes. */
const LOCALES = Object.keys(NAMES);

module.exports = { NAMES, LOCALES };
