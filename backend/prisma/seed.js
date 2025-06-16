const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  
  // Проверяем что модели доступны
  if (!prisma.camera) {
    console.error('❌ Camera model not available');
    console.log('Available:', Object.keys(prisma).filter(k => !k.startsWith('$')));
    return;
  }

  // Создаем 24 камеры
  const cameras = [];
  for (let i = 1; i <= 24; i++) {
    try {
      const camera = await prisma.camera.upsert({
        where: { channelId: i },
        update: {},
        create: {
          channelId: i,
          name: `Камера ${i}`,
          position: i,
          rtspUrl: `rtsp://${process.env.RTSP_USER}:${process.env.RTSP_PASS}@${process.env.RTSP_BASE_IP}:${process.env.RTSP_PORT}/chID=${i}&streamType=main`,
          status: 'OFFLINE'
        }
      });
      cameras.push(camera);
      console.log(`✅ Camera ${i} created/updated`);
    } catch (error) {
      console.error(`❌ Error creating camera ${i}:`, error.message);
    }
  }

  // Создаем пользователей из существующей системы
  const users = [
    { username: 'admin', role: 'ADMIN' },
    { username: 'operator', role: 'OPERATOR' },
    { username: 'user1', role: 'USER' },
    { username: 'user2', role: 'USER' },
    { username: 'user3', role: 'USER' },
    { username: 'user4', role: 'USER' }
  ];

  for (const userData of users) {
    try {
      const user = await prisma.user.upsert({
        where: { username: userData.username },
        update: {},
        create: userData
      });
      console.log(`👤 User ${user.username} (${user.role}) created/updated`);

      // Назначаем права доступа к камерам
      if (userData.role === 'ADMIN' || userData.role === 'OPERATOR') {
        // Админ и оператор - доступ ко всем камерам
        for (const camera of cameras) {
          await prisma.userCameraPermission.upsert({
            where: {
              userId_cameraId: {
                userId: user.id,
                cameraId: camera.id
              }
            },
            update: {},
            create: {
              userId: user.id,
              cameraId: camera.id,
              canView: true,
              canRecord: userData.role === 'ADMIN' || userData.role === 'OPERATOR'
            }
          });
        }
      } else {
        // Обычные пользователи - доступ к определенным группам камер
        const userNumber = parseInt(userData.username.replace('user', ''));
        const startCamera = (userNumber - 1) * 6 + 1; // user1: 1-6, user2: 7-12, etc.
        const endCamera = Math.min(startCamera + 5, 24);

        for (let i = startCamera; i <= endCamera; i++) {
          const camera = cameras.find(c => c.channelId === i);
          if (camera) {
            await prisma.userCameraPermission.upsert({
              where: {
                userId_cameraId: {
                  userId: user.id,
                  cameraId: camera.id
                }
              },
              update: {},
              create: {
                userId: user.id,
                cameraId: camera.id,
                canView: true,
                canRecord: false
              }
            });
          }
        }
        console.log(`🔐 User ${userData.username} assigned cameras ${startCamera}-${endCamera}`);
      }
    } catch (error) {
      console.error(`❌ Error creating user ${userData.username}:`, error.message);
    }
  }

  // Создаем API ключ для интеграции с основным API
  try {
    await prisma.apiKey.upsert({
      where: { keyHash: 'main_api_access_key_hash' },
      update: {},
      create: {
        keyHash: 'main_api_access_key_hash', // в реальности нужно будет хешировать
        serviceName: 'main_api',
        permissions: {
          cameras: 'all',
          actions: ['read', 'write', 'manage']
        },
        expiresAt: null // не истекает
      }
    });
    console.log('🔑 API key created/updated');
  } catch (error) {
    console.error('❌ Error creating API key:', error.message);
  }

  console.log('🎉 Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });