window.DONATION_PROJECTS = [
  {
    id: 'housing',
    slug: 'housing',
    title: 'ช่วยที่อยู่อาศัยผู้ยากไร้',
    subtitle: 'ร่วมมอบโอกาสให้ครอบครัวที่ขาดแคลนมีบ้านที่ปลอดภัย',
    description: 'สนับสนุนการสร้าง ซ่อมแซม และฟื้นฟูที่อยู่อาศัยสำหรับครอบครัวยากไร้',
    cover_image: 'https://images.unsplash.com/photo-1518098268026-4e89f1a2cd8e?auto=format&fit=crop&w=1200&q=80',
    tone: 'green'
  },
  {
    id: 'education',
    slug: 'education',
    title: 'เพื่อการศึกษา ส่งน้องเรียน',
    subtitle: 'สนับสนุนอนาคตของเด็ก ๆ ด้วยทุนการศึกษาและอุปกรณ์การเรียน',
    description: 'ร่วมผลักดันโอกาสทางการศึกษาสำหรับเด็กและเยาวชน',
    cover_image: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80',
    tone: 'blue'
  },
  {
    id: 'food',
    slug: 'food',
    title: 'อาหารและของจำเป็น',
    subtitle: 'ช่วยเหลือครอบครัวเปราะบางด้วยอาหารแห้งและสิ่งของจำเป็น',
    description: 'มอบความอุ่นใจในวันที่ขาดแคลน ผ่านอาหารและของใช้จำเป็น',
    cover_image: 'https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=1200&q=80',
    tone: 'orange'
  },
  {
    id: 'medical',
    slug: 'medical',
    title: 'ค่ารักษาพยาบาล',
    subtitle: 'ช่วยผู้ป่วยยากไร้เข้าถึงการรักษาอย่างต่อเนื่อง',
    description: 'ช่วยเรื่องค่าเดินทาง ค่ายา และค่าใช้จ่ายรักษาจำเป็น',
    cover_image: 'https://images.unsplash.com/photo-1584515933487-779824d29309?auto=format&fit=crop&w=1200&q=80',
    tone: 'red'
  },
  {
    id: 'emergency',
    slug: 'emergency',
    title: 'เคสฉุกเฉินเร่งด่วน',
    subtitle: 'ระดมความช่วยเหลือฉุกเฉินในสถานการณ์วิกฤต',
    description: 'ใช้สำหรับเคสด่วนที่ต้องการการช่วยเหลือภายในเวลาอันสั้น',
    cover_image: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1200&q=80',
    tone: 'purple'
  },
  {
    id: 'orphans',
    slug: 'orphans',
    title: 'ช่วยเหลือเด็กกำพร้า',
    subtitle: 'เติมโอกาสและความอบอุ่นให้เด็กที่ขาดผู้ดูแล',
    description: 'สนับสนุนค่าใช้จ่ายพื้นฐานและการดูแลรายเดือน',
    cover_image: 'https://images.unsplash.com/photo-1516627145497-ae6968895b74?auto=format&fit=crop&w=1200&q=80',
    tone: 'teal'
  },
  {
    id: 'elderly',
    slug: 'elderly',
    title: 'ผู้สูงอายุยากไร้',
    subtitle: 'ช่วยเหลือผู้สูงอายุที่อยู่ลำพังและขาดรายได้',
    description: 'สนับสนุนค่าใช้จ่ายประจำวันและอุปกรณ์จำเป็นสำหรับผู้สูงอายุ',
    cover_image: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?auto=format&fit=crop&w=1200&q=80',
    tone: 'gray'
  }
];

window.DONATION_CASES = {
  housing: [
    {
      id: 'narathiwat-home-001',
      case_code: 'DON-HOU-001',
      title: 'ช่วยครอบครัวผู้ยากไร้ จังหวัดนราธิวาส',
      province: 'จังหวัดนราธิวาส',
      description: 'ซ่อมแซมหลังคาและพื้นบ้านให้ครอบครัวที่ได้รับผลกระทบจากสภาพความเป็นอยู่ไม่ปลอดภัย',
      target_amount: 30000,
      raised_amount: 105600,
      cover_image: 'https://images.unsplash.com/photo-1460317442991-0ec209397118?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    },
    {
      id: 'songkhla-home-002',
      case_code: 'DON-HOU-002',
      title: 'ซ่อมบ้านผู้สูงอายุ จังหวัดสงขลา',
      province: 'จังหวัดสงขลา',
      description: 'ปรับปรุงห้องนอนและห้องน้ำให้ปลอดภัยสำหรับผู้สูงอายุที่อยู่ลำพัง',
      target_amount: 45000,
      raised_amount: 18800,
      cover_image: 'https://images.unsplash.com/photo-1448630360428-65456885c650?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ],
  education: [
    {
      id: 'education-001',
      case_code: 'DON-EDU-001',
      title: 'ทุนการศึกษาน้องนักเรียน 3 คน',
      province: 'จังหวัดยะลา',
      description: 'สนับสนุนค่าอุปกรณ์การเรียน ค่าเดินทาง และค่าใช้จ่ายเบื้องต้น',
      target_amount: 25000,
      raised_amount: 12100,
      cover_image: 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ],
  food: [
    {
      id: 'food-001',
      case_code: 'DON-FOO-001',
      title: 'ถุงยังชีพสำหรับครอบครัวเปราะบาง',
      province: 'จังหวัดตรัง',
      description: 'จัดชุดถุงยังชีพและของใช้จำเป็นรายเดือนให้ครอบครัวเปราะบาง',
      target_amount: 20000,
      raised_amount: 8500,
      cover_image: 'https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ],
  medical: [
    {
      id: 'medical-001',
      case_code: 'DON-MED-001',
      title: 'ช่วยค่ารักษาผู้ป่วยเรื้อรัง',
      province: 'จังหวัดปัตตานี',
      description: 'ค่าเดินทางพบแพทย์และค่าใช้จ่ายด้านยาอย่างต่อเนื่อง',
      target_amount: 35000,
      raised_amount: 14200,
      cover_image: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ],
  emergency: [
    {
      id: 'emergency-001',
      case_code: 'DON-EMG-001',
      title: 'ช่วยเหลือฉุกเฉินผู้ประสบเหตุไฟไหม้',
      province: 'จังหวัดนราธิวาส',
      description: 'เร่งจัดหาสิ่งของจำเป็นและที่พักชั่วคราวภายใน 48 ชั่วโมง',
      target_amount: 50000,
      raised_amount: 19400,
      cover_image: 'https://images.unsplash.com/photo-1469571486292-b53601020f66?auto=format&fit=crop&w=1200&q=80',
      status: 'urgent'
    }
  ],
  orphans: [
    {
      id: 'orphans-001',
      case_code: 'DON-ORP-001',
      title: 'สนับสนุนค่าใช้จ่ายเด็กกำพร้า',
      province: 'จังหวัดสงขลา',
      description: 'ช่วยค่าอาหาร การเรียน และอุปกรณ์จำเป็นของเด็กกำพร้า',
      target_amount: 28000,
      raised_amount: 9300,
      cover_image: 'https://images.unsplash.com/photo-1516627145497-ae6968895b74?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ],
  elderly: [
    {
      id: 'elderly-001',
      case_code: 'DON-ELD-001',
      title: 'ผู้สูงอายุยากไร้ในชุมชน',
      province: 'จังหวัดนราธิวาส',
      description: 'สนับสนุนค่าครองชีพและอุปกรณ์จำเป็นสำหรับผู้สูงอายุ',
      target_amount: 22000,
      raised_amount: 6700,
      cover_image: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?auto=format&fit=crop&w=1200&q=80',
      status: 'active'
    }
  ]
};

window.DONATION_RECENT = {
  'narathiwat-home-001': [
    { donor_name: 'KCK2', amount: 15000, created_at: '2026-04-03T10:38:00+07:00' },
    { donor_name: 'KCK_Test', amount: 10000, created_at: '2026-04-03T10:18:00+07:00' },
    { donor_name: 'ผู้ไม่ประสงค์เอ่ยนาม', amount: 500, created_at: '2026-04-03T09:52:00+07:00' },
    { donor_name: 'ผู้ไม่ประสงค์เอ่ยนาม', amount: 10000, created_at: '2026-04-03T09:12:00+07:00' },
    { donor_name: 'kck', amount: 500, created_at: '2026-04-03T08:48:00+07:00' }
  ]
};

window.DONATION_PRESETS = [100, 300, 500];
