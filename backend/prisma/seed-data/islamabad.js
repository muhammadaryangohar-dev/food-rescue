// Islamabad demo dataset for FoodRescue.
//
// ACADEMIC DEMO DATA — READ THIS:
//  - Organisation names are real, well-known Islamabad restaurants, hotels/venues
//    and NGOs, used ONLY to make the CSC336 project demo realistic. None of them is
//    affiliated with FoodRescue, and every listing, request, donation and rescue in
//    this database is SIMULATED.
//  - Locations are placed at sector / market level; coordinates are APPROXIMATE and
//    a branch may have moved or closed. Verify before relying on them.
//  - Organisations under an "invented names" comment below are generic names made up
//    for the demo (placed in real areas); they do not refer to any real business.
//  - All PEOPLE (account holders, volunteers), all FOOD LICENCE NUMBERS (IFA-DEMO-...)
//    and all phone numbers, including the NGO contact numbers shown in the public NGO
//    directory, are FICTIONAL. Phone numbers use the 0300-00xxxxx range on purpose so
//    they do not belong to anyone. They are NOT the real organisations' numbers.
//
// Who donates: only licensed food businesses (restaurants, and marquees / caterers /
// event venues). Households do not donate; they use the public NGO directory.
//
// The short demo logins (restaurant@, ngo@, volunteer@ ...) are attached to some of
// these organisations so the documented test accounts keep working.

// ---------------------------------------------------------------- restaurants (35)
// [slug, name, area, address, status, menu style]
export const RESTAURANTS = [
  ['savour-foods', 'Savour Foods', 'Blue Area', 'Jinnah Avenue, Blue Area', 'VERIFIED', 'desi'],
  ['kabul-restaurant', 'Kabul Restaurant', 'F-7', 'Jinnah Super Market, F-7 Markaz', 'VERIFIED', 'afghan'],
  ['usmania', 'Usmania Restaurant', 'Blue Area', 'Jinnah Avenue, Blue Area', 'VERIFIED', 'desi'],
  ['chaaye-khana', 'Chaaye Khana', 'F-6', 'Super Market, F-6 Markaz', 'VERIFIED', 'cafe'],
  ['hot-spot', 'Hot Spot', 'Kohsar Market (F-6/3)', 'Kohsar Market, F-6/3', 'VERIFIED', 'cafe'],
  ['street-1-cafe', 'Street 1 Cafe', 'Kohsar Market (F-6/3)', 'Kohsar Market, F-6/3', 'VERIFIED', 'continental'],
  ['tuscany-courtyard', 'Tuscany Courtyard', 'F-6', 'F-6/3, near Kohsar Market', 'VERIFIED', 'italian'],
  ['des-pardes', 'Des Pardes', 'Saidpur Village', 'Saidpur Village', 'VERIFIED', 'desi'],
  ['burning-brownie', 'Burning Brownie', 'F-7', 'F-7/2', 'VERIFIED', 'bakery'],
  ['bravo-foods', 'Bravo Foods', 'F-7', 'Jinnah Super Market, F-7 Markaz', 'VERIFIED', 'fastfood'],
  ['howdy', 'Howdy', 'F-7', 'F-7 Markaz', 'VERIFIED', 'fastfood'],
  ['ranchers', 'Ranchers', 'F-7', 'F-7 Markaz', 'VERIFIED', 'fastfood'],
  ['tehzeeb-bakers', 'Tehzeeb Bakers', 'Blue Area', 'Jinnah Avenue, Blue Area', 'VERIFIED', 'bakery'],
  ['rahat-bakers', 'Rahat Bakers', 'F-8', 'F-8 Markaz', 'VERIFIED', 'bakery'],
  ['kitchen-cuisine', 'Kitchen Cuisine', 'Blue Area', 'Blue Area', 'VERIFIED', 'bakery'],
  ['kfc-f7', 'KFC F-7', 'F-7', 'Jinnah Super Market, F-7 Markaz', 'VERIFIED', 'fastfood'],
  ['mcdonalds-f9', "McDonald's F-9 Park", 'F-9 Park', 'F-9 Park', 'VERIFIED', 'fastfood'],
  ['pizza-hut-f10', 'Pizza Hut F-10', 'F-10', 'F-10 Markaz', 'VERIFIED', 'fastfood'],
  ['hardees-centaurus', "Hardee's Centaurus", 'Centaurus (F-8/4)', 'The Centaurus Mall, F-8/4', 'VERIFIED', 'fastfood'],
  ['cheezious-i8', 'Cheezious I-8', 'I-8', 'I-8 Markaz', 'VERIFIED', 'fastfood'],
  ['mandarin-kitchen', 'Mandarin Kitchen', 'Blue Area', 'Blue Area', 'VERIFIED', 'chinese'],
  ['cafe-lattice', 'Cafe Lattice', 'F-7', 'F-7/3', 'VERIFIED', 'cafe'],
  ['ginyaki', 'Ginyaki', 'F-7', 'F-7 Markaz', 'VERIFIED', 'chinese'],
  ['gloria-jeans', "Gloria Jean's Coffees Centaurus", 'Centaurus (F-8/4)', 'The Centaurus Mall, F-8/4', 'VERIFIED', 'cafe'],
  ['fatburger', 'Fatburger', 'F-7', 'F-7 Markaz', 'VERIFIED', 'fastfood'],
  ['cafe-aylanto', 'Cafe Aylanto', 'F-7', 'F-7/3', 'PENDING', 'continental'],
  ['asian-wok', 'Asian Wok', 'F-7', 'F-7 Markaz', 'PENDING', 'chinese'],
  ['nandos-f7', "Nando's F-7", 'F-7', 'Jinnah Super Market, F-7 Markaz', 'VERIFIED', 'continental'],
  ['optp-f10', 'OPTP F-10', 'F-10', 'F-10 Markaz', 'VERIFIED', 'fastfood'],
  ['dominos-g9', "Domino's G-9", 'G-9', 'G-9 Markaz', 'VERIFIED', 'fastfood'],
  ['bundu-khan', 'Bundu Khan', 'Blue Area', 'Jinnah Avenue, Blue Area', 'VERIFIED', 'desi'],
  ['tandoori', 'Tandoori Restaurant', 'Blue Area', 'Blue Area', 'VERIFIED', 'desi'],
  ['tim-hortons', 'Tim Hortons Centaurus', 'Centaurus (F-8/4)', 'The Centaurus Mall, F-8/4', 'VERIFIED', 'cafe'],
  ['14th-street-pizza', '14th Street Pizza', 'Bahria Town Phase 7', 'Civic Centre, Bahria Town Phase 7', 'VERIFIED', 'fastfood'],
  ['hot-and-chilli', 'Hot & Chilli', 'DHA Phase 2', 'Sector E Commercial, DHA Phase 2', 'VERIFIED', 'fastfood'],
];

// Restaurants whose food licence has expired (the admin cannot approve them until renewed)
export const EXPIRED_LICENCE = ['cafe-aylanto'];

// ---------------------------------------------------------------- marquees / caterers (27)
// Hotels, banquet venues, marquees and caterers that cook for weddings, conferences and banquets
export const MARQUEES_CATERERS = [
  ['serena-hotel', 'Serena Hotel Islamabad', 'G-5', 'Khayaban-e-Suhrawardy, G-5', 'VERIFIED'],
  ['marriott-islamabad', 'Islamabad Marriott Hotel', 'F-5', 'Aga Khan Road, F-5', 'VERIFIED'],
  ['ramada-islamabad', 'Ramada by Wyndham Islamabad', 'Murree Road', 'Club Road, near Murree Road', 'VERIFIED'],
  ['islamabad-club', 'Islamabad Club', 'Murree Road', 'Murree Road', 'VERIFIED'],
  ['pak-china-centre', 'Pak-China Friendship Centre', 'Shakarparian', 'Garden Avenue, Shakarparian', 'VERIFIED'],
  ['jinnah-convention', 'Jinnah Convention Centre', 'G-5', 'Constitution Avenue, G-5', 'PENDING'],
  // invented names (generic), real areas
  ['park-road-banquet', 'Park Road Banquet Hall', 'Park Road (Chak Shahzad)', 'Park Road, Chak Shahzad', 'VERIFIED'],
  ['capital-banquet', 'Capital Banquet & Marquee', 'DHA Phase 2', 'GT Road entrance, DHA Phase 2', 'VERIFIED'],
  ['royal-taste-caterers', 'Royal Taste Caterers', 'G-11', 'G-11 Markaz', 'VERIFIED'],
  // E-11 / Main Margalla Road marquees (real names, from public wedding-venue listings)
  ['monal-marquee', 'Monal Marquee', 'E-11', 'Street 12, Main Service Road, E-11', 'VERIFIED'],
  ['aura-grande', 'Aura Grande Complex', 'E-11', 'Main Margalla Road, E-11/4', 'VERIFIED'],
  ['taj-marquee', 'Taj Marquee', 'E-11', 'Main Margalla Road, E-11/4', 'VERIFIED'],
  ['margalla-grande', 'Margalla Grande', 'E-11', 'Main Margalla Road, Golra NPF, E-11/4', 'VERIFIED'],
  ['paradise-marquee', 'Paradise Marquee', 'E-11', 'Main Margalla Road, E-11/4', 'PENDING'],
  // Islamabad Expressway marquees (real names)
  ['fortress-marquee', 'Fortress Marquee', 'Islamabad Expressway', 'Near Madina Town, Islamabad Expressway', 'VERIFIED'],
  ['empire-marquee', 'Empire Marquee', 'Islamabad Expressway', 'Near PSO pump, Kuri Road, Islamabad Expressway', 'VERIFIED'],
  ['montreal-marquee', 'Montreal Marquee', 'Islamabad Expressway', 'Near Gulberg Greens, Islamabad Expressway', 'VERIFIED'],
  ['royal-marquee', 'Royal Marquee', 'Islamabad Expressway', 'Wildlife Park Chowk, Islamabad Expressway', 'VERIFIED'],
  // Bahria Town (real name)
  ['rubaish-marquee', 'Rubaish Marquee', 'Bahria Town Phase 7', 'Bahria Town Phase 7', 'VERIFIED'],
  // invented names (generic) in Bahria, DHA and other areas
  ['bahria-grand-hall', 'Bahria Grand Hall', 'Bahria Town Phase 7', 'Civic Centre, Bahria Town Phase 7', 'VERIFIED'],
  ['crescent-banquet', 'Crescent Banquet', 'Bahria Enclave', 'Main Boulevard, Bahria Enclave', 'VERIFIED'],
  ['silver-oak-marquee', 'Silver Oak Marquee', 'Bahria Enclave', 'Sector H, Bahria Enclave', 'VERIFIED'],
  ['zarrar-banquet', 'Zarrar Banquet Hall', 'DHA Phase 2', 'GT Road side, DHA Phase 2', 'VERIFIED'],
  ['defence-garden-marquee', 'Defence Garden Marquee', 'DHA Phase 2', 'Sector A, DHA Phase 2', 'VERIFIED'],
  ['golden-palm-marquee', 'Golden Palm Marquee', 'DHA Phase 2', 'Sector J, DHA Phase 2', 'PENDING'],
  ['spice-route-caterers', 'Spice Route Caterers', 'G-13', 'G-13 Markaz', 'VERIFIED'],
  ['nawab-caterers', 'Nawab Caterers', 'I-9', 'I-9 Industrial Area', 'VERIFIED'],
];

// ---------------------------------------------------------------- NGOs (27)
// [slug, name, area, address, status, daily capacity (servings), service radius km,
//  NGO type, beneficiaries (people served per day), shown in the public directory]
// Verified NGOs that opted in appear in GET /api/ngos with a FICTIONAL demo contact
// number and a generic description. Akhuwat has NOT opted in (shows the opt-in rule).
export const NGOS = [
  ['rizq', 'Rizq', 'F-8', 'F-8 Markaz', 'VERIFIED', 400, 15, 'FOOD_KITCHEN', 250, true],
  ['robin-hood-army', 'Robin Hood Army Islamabad', 'F-6', 'F-6 Markaz', 'VERIFIED', 300, 12, 'FOOD_KITCHEN', 200, true],
  ['edhi-foundation', 'Edhi Foundation Islamabad', 'G-9', 'G-9 Markaz', 'VERIFIED', 500, 15, 'SHELTER', 220, true],
  ['saylani', 'Saylani Welfare Trust Islamabad', 'I-8', 'I-8 Markaz', 'VERIFIED', 600, 15, 'FOOD_KITCHEN', 400, true],
  ['sos-village', "SOS Children's Village Islamabad", 'H-8', 'H-8', 'VERIFIED', 150, 10, 'ORPHANAGE', 60, true],
  ['bait-ul-mal', 'Pakistan Bait-ul-Mal Sweet Home', 'G-10', 'G-10', 'VERIFIED', 200, 10, 'ORPHANAGE', 80, true],
  ['akhuwat', 'Akhuwat Islamabad', 'G-8', 'G-8 Markaz', 'VERIFIED', 250, 12, 'OTHER', 150, false],
  ['al-khidmat', 'Al-Khidmat Foundation Islamabad', 'I-10', 'I-10 Markaz', 'PENDING', 300, 12, 'SHELTER', 150, true],
  // more real organisations that run free-meal or welfare work (sector placement is illustrative)
  ['chhipa', 'Chhipa Welfare Association Islamabad', 'I-9', 'I-9 Markaz', 'VERIFIED', 300, 12, 'SHELTER', 120, true],
  ['jdc-welfare', 'JDC Welfare Organization Islamabad', 'G-11', 'G-11 Markaz', 'VERIFIED', 350, 12, 'FOOD_KITCHEN', 200, true],
  ['alamgir-welfare', 'Alamgir Welfare Trust Islamabad', 'G-7', 'G-7 Markaz', 'VERIFIED', 300, 12, 'FOOD_KITCHEN', 180, true],
  ['meso-pakistan', 'MESO Pakistan Islamabad', 'F-10', 'F-10 Markaz', 'VERIFIED', 150, 10, 'FOOD_KITCHEN', 80, true],
  ['thali', 'Thali Islamabad', 'F-11', 'F-11 Markaz', 'VERIFIED', 200, 12, 'FOOD_KITCHEN', 120, true],
  ['bahria-dastarkhwan', 'Bahria Town Dastarkhwan Khanna Pul', 'Islamabad Expressway', 'Khanna Pul, Islamabad Expressway', 'VERIFIED', 500, 15, 'FOOD_KITCHEN', 300, true],
  ['shifa-foundation', 'Shifa Foundation', 'H-8', 'H-8/4', 'VERIFIED', 150, 10, 'OTHER', 100, true],
  ['red-crescent', 'Pakistan Red Crescent Society Islamabad', 'G-6', 'G-6', 'VERIFIED', 250, 12, 'SHELTER', 120, false],
  // invented names (generic), so Bahria, DHA and the Expressway are covered
  ['bahria-community-kitchen', 'Bahria Community Kitchen', 'Bahria Town Phase 7', 'Spring North, Bahria Town Phase 7', 'VERIFIED', 300, 12, 'FOOD_KITCHEN', 150, true],
  ['dha-welfare-dastarkhwan', 'DHA Welfare Dastarkhwan', 'DHA Phase 2', 'Sector E, DHA Phase 2', 'VERIFIED', 250, 12, 'FOOD_KITCHEN', 120, true],
  ['expressway-langar', 'Expressway Langar Trust', 'Islamabad Expressway', 'Koral Chowk, Islamabad Expressway', 'VERIFIED', 300, 15, 'FOOD_KITCHEN', 160, true],
  ['margalla-old-age-home', 'Margalla Old Age Home', 'E-11', 'E-11/2', 'VERIFIED', 90, 8, 'OLD_AGE_HOME', 40, true],
  ['sukoon-elders-home', 'Sukoon Elders Home', 'G-13', 'G-13/1', 'VERIFIED', 80, 8, 'OLD_AGE_HOME', 35, true],
  ['roshni-orphanage', 'Roshni Orphanage', 'I-9', 'I-9/4', 'VERIFIED', 120, 10, 'ORPHANAGE', 50, true],
  ['umeed-childrens-home', "Umeed Children's Home", 'Bahria Enclave', 'Sector C, Bahria Enclave', 'VERIFIED', 100, 10, 'ORPHANAGE', 45, true],
  ['noor-shelter', 'Noor Shelter Home', 'G-11', 'G-11/3', 'VERIFIED', 150, 10, 'SHELTER', 70, true],
  ['barkat-street-kitchen', 'Barkat Street Kitchen', 'I-10', 'I-10 Markaz', 'VERIFIED', 200, 10, 'FOOD_KITCHEN', 100, false],
  ['ujala-womens-shelter', "Ujala Women's Shelter", 'F-11', 'F-11/1', 'PENDING', 80, 8, 'SHELTER', 40, true],
  ['khidmat-kitchen-park-road', 'Khidmat Kitchen Park Road', 'Park Road (Chak Shahzad)', 'Park Road, Chak Shahzad', 'VERIFIED', 200, 12, 'FOOD_KITCHEN', 90, true],
];

// ---------------------------------------------------------------- fictional people
// Account holders for organisations (one manager each), in order of the lists above
export const MANAGER_NAMES = [
  'Ahmed Raza', 'Bilal Khan', 'Usman Tariq', 'Sana Malik', 'Hamza Qureshi', 'Ayesha Siddiqui', 'Faisal Mehmood',
  'Zainab Hussain', 'Omar Farooq', 'Hira Javed', 'Kamran Akhtar', 'Mariam Iqbal', 'Imran Shah', 'Nadia Aslam',
  'Saad Ali', 'Rabia Anwar', 'Tariq Jamil', 'Mehwish Rafiq', 'Adnan Sheikh', 'Fatima Zahra', 'Junaid Butt',
  'Sadia Noor', 'Waqas Ahmed', 'Amna Riaz', 'Shahid Latif', 'Iqra Saleem', 'Naveed Abbasi', 'Asma Kazmi',
  'Haris Chaudhry', 'Mahnoor Khalid', 'Danish Mirza', 'Sobia Rehman', 'Arslan Haider', 'Lubna Pervaiz',
  'Talha Nadeem', 'Kiran Ashraf', 'Fahad Yousaf', 'Rida Zafar', 'Moiz Hassan', 'Saba Qamar Ali', 'Zeeshan Haq',
  'Usama Siddique', 'Hafsa Imtiaz', 'Waleed Anjum',
  'Ali Hamza', 'Sidra Batool', 'Hassan Nawaz', 'Maham Aziz', 'Shoaib Akram', 'Nimra Khalil', 'Bilal Ashfaq',
  'Anum Shahzad', 'Rizwan Ullah', 'Komal Saeed', 'Yasir Mahmood', 'Hina Bashir', 'Asad Rehan', 'Samina Gul',
  'Kashif Iqbal', 'Uzma Tariq', 'Jawad Hussain', 'Aqsa Mumtaz', 'Nabeel Qadir', 'Ramsha Ijaz', 'Shehzad Akhtar',
  'Tayyaba Nisar', 'Fawad Ilyas', 'Madiha Sultan', 'Ehsan Karim', 'Saima Arif', 'Wajahat Shah', 'Bushra Hameed',
  'Atif Nazir', 'Farah Naz', 'Raheel Anwar', 'Zoya Shafiq', 'Qasim Javaid', 'Mehreen Fazal', 'Sarmad Iqbal',
  'Ammara Yasin', 'Khurram Shahid', 'Nida Pervez', 'Umair Saleem', 'Rimsha Asghar', 'Taimoor Aslam', 'Fiza Kanwal',
  'Hammad Rauf', 'Javeria Ahsan', 'Salman Zia', 'Arooj Fatima', 'Daniyal Kiani',
];

// Volunteers (fictional) [name, availability, service area or null = anywhere, status, no-shows]
export const VOLUNTEERS = [
  ['Hassan Raza', 'Evenings, 6–10 pm', null, 'VERIFIED', 0],
  ['Areeba Khan', 'Weekends', 'F-7', 'VERIFIED', 0],
  ['Muhammad Owais', 'Weekday afternoons', 'Blue Area', 'VERIFIED', 0],
  ['Laiba Farooq', 'Evenings', 'F-6', 'VERIFIED', 0],
  ['Abdullah Sheikh', 'Any time', null, 'VERIFIED', 1],
  ['Maryam Tahir', 'Weekends', 'G-9', 'VERIFIED', 0],
  ['Ibrahim Malik', 'Late nights (after 10 pm)', 'F-8', 'VERIFIED', 0],
  ['Noor Fatima', 'Evenings', 'I-8', 'VERIFIED', 0],
  ['Zain Ul Abideen', 'Weekday mornings', 'G-10', 'VERIFIED', 2],
  ['Eman Rizwan', 'Weekends', 'F-10', 'VERIFIED', 0],
  ['Saim Javed', 'Evenings', null, 'PENDING', 0],
  ['Alishba Noor', 'Any time', 'G-11', 'PENDING', 0],
  ['Ayan Qureshi', 'Evenings', 'E-11', 'VERIFIED', 0],
  ['Mahrukh Ali', 'Weekends', 'Bahria Town Phase 7', 'VERIFIED', 0],
  ['Shayan Akhtar', 'Any time', 'DHA Phase 2', 'VERIFIED', 0],
];

// Menu items by restaurant style: [name, category name, typical daily sales]
export const MENUS = {
  desi: [['Chicken Biryani', 'Rice and biryani', 120], ['Chicken Karahi', 'Cooked meals', 80], ['Naan', 'Bread and bakery', 300], ['Daal Mash', 'Lentils and vegetable dishes', 70], ['Halwa Puri', 'Breakfast items', 90]],
  afghan: [['Kabuli Pulao', 'Rice and biryani', 110], ['Chapli Kabab', 'Barbecue and kababs', 90], ['Afghani Naan', 'Bread and bakery', 250], ['Mutton Tikka', 'Barbecue and kababs', 60]],
  cafe: [['Club Sandwich', 'Cooked meals', 70], ['Chicken Pasta', 'Pizza and pasta', 50], ['Croissant', 'Bread and bakery', 60], ['Cold Coffee', 'Drinks and juices', 80]],
  continental: [['Grilled Chicken Platter', 'Barbecue and kababs', 60], ['Alfredo Pasta', 'Pizza and pasta', 55], ['Garlic Bread', 'Bread and bakery', 80], ['Caesar Salad', 'Salads and raita', 40]],
  italian: [['Lasagna', 'Pizza and pasta', 45], ['Margherita Pizza', 'Pizza and pasta', 70], ['Tiramisu', 'Sweets and desserts', 40], ['Garden Salad', 'Salads and raita', 30]],
  bakery: [['Chicken Patties', 'Bread and bakery', 200], ['Sandwich Bread', 'Bread and bakery', 150], ['Chocolate Pastry', 'Sweets and desserts', 120], ['Milk Cake', 'Dairy', 60]],
  fastfood: [['Zinger Burger', 'Fast food', 180], ['Fries', 'Fast food', 220], ['Chicken Wrap', 'Fast food', 90], ['Fajita Pizza', 'Pizza and pasta', 70], ['Soft Drinks', 'Drinks and juices', 250]],
  chinese: [['Chicken Fried Rice', 'Rice and biryani', 90], ['Chicken Manchurian', 'Cooked meals', 70], ['Hot and Sour Soup', 'Cooked meals', 60], ['Vegetable Chowmein', 'Lentils and vegetable dishes', 50]],
  // marquees / caterers: a typical Pakistani wedding / banquet menu (planned per event)
  marquee: [
    ['Chicken Biryani', 'Rice and biryani', 0], ['Mutton Qorma', 'Cooked meals', 0], ['Chicken Tikka and Seekh Kabab', 'Barbecue and kababs', 0],
    ['Naan and Roghni Naan', 'Bread and bakery', 0], ['Mixed Sabzi', 'Lentils and vegetable dishes', 0], ['Salad and Raita', 'Salads and raita', 0],
    ['Zarda and Kheer', 'Sweets and desserts', 0], ['Fresh Fruit', 'Fruit and vegetables', 0], ['Soft Drinks and Mineral Water', 'Drinks and juices', 0],
  ],
};

// Short demo logins (documented in docs/api/README.md) -> which record they belong to
export const DEMO_LOGINS = {
  restaurant: 'savour-foods',
  events: 'serena-hotel',
  caterer: 'park-road-banquet',
  ngo: 'rizq',
  ngo2: 'robin-hood-army',
  'ngo-pending': 'al-khidmat',
  volunteer: 'Hassan Raza',
  volunteer2: 'Areeba Khan',
  'volunteer-pending': 'Saim Javed',
};
