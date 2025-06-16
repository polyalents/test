const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  
  try {
    // Очищаем таблицы в правильном порядке (из-за foreign keys)
    console.log('🧹 Очищаем существующие данные...');
    await prisma.userCameraPermission.deleteMany();
    await prisma.recording.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.user.deleteMany();
    await prisma.camera.deleteMany();
    
    console.log('✅ Старые данные удалены');
    
    // Создаем 24 камеры
    console.log('📹 Создаем камеры...');
    const cameras = [];
    for (let i = 1; i <= 24; i++) {
      const camera = await prisma.camera.create({
        data: {
          channelId: i,
          name: `Камера ${i}`,
          position: i,
          rtspUrl: `rtsp://${process.env.RTSP_USER || 'admin'}:${process.env.RTSP_PASS || 'admin123'}@${process.env.RTSP_BASE_IP || '192.168.4.200'}:${process.env.RTSP_PORT || '62342'}/chID=${i}&streamType=main`,
          status: 'OFFLINE',
          isActive: true
        }
      });
      cameras.push(camera);
      console.log(`✅ Camera ${i} created (ID: ${camera.id})`);
    }

    // Создаем пользователей
    console.log('👥 Создаем пользователей...');
    const users = [
      { username: 'admin', role: 'ADMIN' },
      { username: 'operator', role: 'OPERATOR' },
      { username: 'user1', role: 'USER' },
      { username: 'user2', role: 'USER' },
      { username: 'user3', role: 'USER' },
      { username: 'user4', role: 'USER' }
    ];

    for (const userData of users) {
      const user = await prisma.user.create({
        data: userData
      });
      console.log(`👤 User ${user.username} (${user.role}) created (ID: ${user.id})`);

      // Назначаем права доступа к камерам
      if (userData.role === 'ADMIN' || userData.role === 'OPERATOR') {
        // Админ и оператор - доступ ко всем камерам
        console.log(`🔐 Назначаем ${userData.username} доступ ко всем камерам...`);
        for (const camera of cameras) {
          await prisma.userCameraPermission.create({
            data: {
              userId: user.id,
              cameraId: camera.id,
              canView: true,
              canRecord: userData.role === 'ADMIN' || userData.role === 'OPERATOR'
            }
          });
        }
        console.log(`✅ ${userData.username} получил доступ к ${cameras.length} камерам`);
      } else {
        // Обычные пользователи - доступ к определенным группам камер
        const userNumber = parseInt(userData.username.replace('user', ''));
        const startCamera = (userNumber - 1) * 6 + 1; // user1: 1-6, user2: 7-12, etc.
        const endCamera = Math.min(startCamera + 5, 24);

        console.log(`🔐 Назначаем ${userData.username} доступ к камерам ${startCamera}-${endCamera}...`);
        
        for (let i = startCamera; i <= endCamera; i++) {
          const camera = cameras.find(c => c.channelId === i);
          if (camera) {
            await prisma.userCameraPermission.create({
              data: {
                userId: user.id,
                cameraId: camera.id,
                canView: true,
                canRecord: false
              }
            });
          }
        }
        console.log(`✅ ${userData.username} получил доступ к камерам ${startCamera}-${endCamera}`);
      }
    }

    // Создаем API ключ для интеграции с основным API
    console.log('🔑 Создаем API ключ...');
    await prisma.apiKey.create({
      data: {
        keyHash: process.env.API_ACCESS_KEY || 'askr-api-key-2025', // в реальности нужно будет хешировать
        serviceName: 'main_api',
        permissions: {
          cameras: 'all',
          actions: ['read', 'write', 'manage']
        },
        expiresAt: null // не истекает
      }
    });
    console.log('✅ API key created');

    // Создаем несколько тестовых записей
    console.log('📼 Создаем тестовые записи...');
    const testRecordings = [
      {
        cameraId: cameras[0].id, // Камера 1
        filename: 'camera_1_test_recording.mp4',
        duration: 300, // 5 минут
        fileSize: BigInt(52428800), // 50MB
        startedBy: 'admin',
        startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // неделю назад
        endedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 300000) // +5 минут
      },
      {
        cameraId: cameras[1].id, // Камера 2  
        filename: 'camera_2_test_recording.mp4',
        duration: 600, // 10 минут
        fileSize: BigInt(104857600), // 100MB
        startedBy: 'user1',
        startedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 дня назад
        endedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 600000) // +10 минут
      }
    ];

    for (const recordingData of testRecordings) {
      const recording = await prisma.recording.create({
        data: recordingData
      });
      console.log(`📹 Test recording created: ${recording.filename}`);
    }

    console.log('');
    console.log('🎉 Database seeded successfully!');
    console.log('');
    console.log('📊 Статистика:');
    console.log(`📹 Камер: ${cameras.length}`);
    console.log(`👥 Пользователей: ${users.length}`);
    console.log(`🔐 Разрешений: ${await prisma.userCameraPermission.count()}`);
    console.log(`📼 Записей: ${testRecordings.length}`);
    console.log(`🔑 API ключей: 1`);
    console.log('');
    console.log('👤 Пользователи для тестирования:');
    console.log('   admin/admin123 - доступ ко всем 24 камерам');
    console.log('   operator/op123 - доступ ко всем 24 камерам');
    console.log('   user1/user123 - доступ к камерам 1-6');
    console.log('   user2/user456 - доступ к камерам 7-12');
    console.log('   user3/user789 - доступ к камерам 13-18');
    console.log('   user4/user999 - доступ к камерам 19-24');
    
  } catch (error) {
    console.error('❌ Error during seeding:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error('❌ Fatal error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('🔌 Database connection closed');
  });